import { v7 } from "uuid";
import {
  AckIdGenerator,
  AckListener,
  Connection,
  decodeAck,
  decodePing,
  decodeProcedure,
  encodeAck,
  encodeProcedure,
  getMessageType,
  Impl,
  MessageType,
  printMessage,
  Proc,
} from "./core";

/**
 * Takes the procedure's input data and a socket object.
 * The `connection` represents a link to the server.
 */
export type ClientProcHandler<I, O> = (
  input: I,
  connection: Connection
) => O | Promise<O>;

export interface ClientConfig {
  /**
   * Chatter server URL.
   */
  url: string | URL;

  /**
   * Enables extra logging when true.
   */
  verbose?: boolean;
}

export enum ConnectionState {
  Offline,
  Connecting,
  Online,
}

const noop = () => undefined;
const CLIENT_ID_KEY = "chatter.clientId";

function createLogger(verbose = false) {
  return {
    get log() {
      if (!verbose) return noop;
      return console.log.bind(console, "[chatter]");
    },
    get warn() {
      if (!verbose) return noop;
      return console.warn.bind(console, "[chatter]");
    },
    get error() {
      if (!verbose) return noop;
      return console.error.bind(console, "[chatter]");
    },
  };
}

type Logger = ReturnType<typeof createLogger>;

export function createClient(config: ClientConfig): ChatterClient {
  return new ChatterClient(config);
}

class ChatterClient implements Connection {
  #config: ClientConfig;
  #clientId = this.#getClientId();

  #state = ConnectionState.Offline;
  #stateChangeCallbacks = new Set<(state: ConnectionState) => void>();

  #procs = new Map<string, Impl<ClientProcHandler<any, any>>>();

  #socket!: WebSocket;
  #reconnectAttempts = 0;
  #reconnectTimeout: any;

  #ids = new AckIdGenerator();
  #acks = new Map<string, AckListener>();

  #debug: Logger;

  constructor(config: ClientConfig) {
    this.#config = config;
    this.#debug = createLogger(config.verbose);

    document.addEventListener("visibilitychange", this.#onVisibilityChange);
    document.addEventListener("online", this.#onNetworkChange);
    document.addEventListener("offline", this.#onNetworkChange);

    // Create initial connection.
    this.#connect();
  }

  /**
   * The current connection state.
   */
  get state() {
    return this.#state;
  }

  /**
   * Persistent client ID.
   */
  get clientId() {
    return this.#clientId;
  }

  /**
   * Registers a callback to run when the `state` value changes.
   * Returns a function that stops listening for changes.
   */
  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.#stateChangeCallbacks.add(callback);
    return () => void this.#stateChangeCallbacks.delete(callback);
  }

  /**
   * Implements a `Proc` so it can be called from the other end of the connection.
   */
  on<I, O>(proc: Proc<I, O>, handler: ClientProcHandler<I, O>) {
    if (this.#procs.has(proc.name)) {
      console.warn(
        `Procedure '${proc.name}' has already been added and will be overwritten!`
      );
    }
    this.#procs.set(proc.name, { proc, handler });
  }

  async call<O>(proc: Proc<null, O>): Promise<O>;
  async call<I, O>(proc: Proc<I, O>, input: I): Promise<O>;
  async call<I, O>(proc: Proc<I, O>, input?: I): Promise<O> {
    const parsedInput = await proc.parseInput(input);

    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Socket is not open.");
    }

    let timer: any;
    const waitTime = proc.timeout;

    return new Promise<O>((resolve, reject) => {
      // Configure timeout
      timer = setTimeout(() => {
        reject(new Error(`Procedure call timed out after ${waitTime}ms.`));
      }, waitTime);

      // Send over socket, await acknowledgement
      const startTime = Date.now();
      const ackId = this.#ids.next();
      this.#acks.set(ackId, {
        proc,
        resolve: (output) => {
          this.#debug.log("call succeeded", {
            ackId,
            name: proc.name,
            input: parsedInput,
            output,
            elapsed: Date.now() - startTime,
          });
          resolve(output);
        },
        reject: (error) => {
          this.#debug.warn("call failed", {
            ackId,
            name: proc.name,
            input: parsedInput,
            error,
            elapsed: Date.now() - startTime,
          });
          reject(error);
        },
      });
      this.#socket.send(encodeProcedure(proc, ackId, parsedInput));
    }).finally(() => {
      clearTimeout(timer);
    });
  }

  /*===============================*\
  ||           Internal            ||
  \*===============================*/

  #getClientId() {
    let stored = localStorage.getItem(CLIENT_ID_KEY);
    if (!stored) {
      stored = v7();
      localStorage.setItem(CLIENT_ID_KEY, stored);
    }
    return stored;
  }

  #connect() {
    clearTimeout(this.#reconnectTimeout);
    this.#reconnectTimeout = null;

    // No-op if already connected.
    if (this.#socket) {
      if (this.#socket.readyState === WebSocket.OPEN) {
        return this.#setConnectionState(ConnectionState.Online);
      }
      this.#socket.close();
    }

    this.#socket = new WebSocket(this.#config.url);
    this.#socket.binaryType = "arraybuffer";
    this.#socket.addEventListener("open", this.#onOpen);
    this.#socket.addEventListener("close", this.#onClose);
    this.#socket.addEventListener("message", this.#onMessage);
    this.#socket.addEventListener("error", this.#onError);
  }

  #setConnectionState(state: ConnectionState) {
    if (state !== this.#state) {
      this.#state = state;
      for (const callback of this.#stateChangeCallbacks) {
        callback(state);
      }

      if (this.#state === ConnectionState.Offline) {
        // Reject all pending listeners.
        for (const [id, listener] of Array.from(this.#acks.entries())) {
          listener.reject(new Error(`Socket disconnected.`));
          this.#acks.delete(id);
        }
      }
    }
  }

  #updateConnectionState() {
    switch (this.#socket.readyState) {
      case WebSocket.CLOSED:
      case WebSocket.CLOSING:
        this.#setConnectionState(ConnectionState.Offline);
        break;
      case WebSocket.OPEN:
        this.#setConnectionState(ConnectionState.Online);
        break;
      case WebSocket.CONNECTING:
        this.#setConnectionState(ConnectionState.Connecting);
        break;
    }
  }

  #tryReconnect() {
    if (this.#reconnectTimeout != null) return;

    // Reconnect with exponential backoff (max 30 seconds)
    const delay = Math.min(1000 * 2 ** this.#reconnectAttempts++, 30000);
    this.#reconnectTimeout = setTimeout(() => this.#connect(), delay);

    if (this.#reconnectAttempts > 0) {
      this.#debug.log(
        `Attempting socket reconnection in ${delay / 1000} seconds (attempt ${this.#reconnectAttempts}).`
      );
    } else {
      this.#debug.log(`Attempting socket connection.`);
    }
  }

  // ----- Page Events ----- //

  #beforeUnload = () => {
    // Graceful shutdown if the user leaves the page.
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.close(1000, "App unloaded");
    }
  };

  #onVisibilityChange = () => {
    if (
      this.#socket.readyState !== WebSocket.OPEN &&
      document.visibilityState === "visible"
    ) {
      this.#connect();
    }
  };

  #onNetworkChange = () => {
    if (navigator.onLine) {
      this.#connect();
    } else {
      // TODO: Disconnect?
    }
  };

  // ----- Socket Events ----- //

  #onOpen = (event: Event) => {
    this.#debug.log("Socket connected.");

    this.#updateConnectionState();
    window.addEventListener("beforeunload", this.#beforeUnload);
    this.#reconnectAttempts = 0;

    // TODO: Ping
  };

  #onClose = (event: CloseEvent) => {
    this.#debug.warn("Socket closed.");

    this.#updateConnectionState();
    window.removeEventListener("beforeunload", this.#beforeUnload);

    // TODO: Cancel ping

    this.#tryReconnect();
  };

  #onError = (event: Event) => {
    event.preventDefault();

    this.#debug.error("Socket error", event);

    this.#updateConnectionState();
    window.removeEventListener("beforeunload", this.#beforeUnload);

    // TODO: Cancel ping

    this.#tryReconnect();
  };

  #onMessage = (event: MessageEvent) => {
    if (!(event.data instanceof ArrayBuffer)) {
      this.#debug.warn(
        `Message data was not an ArrayBuffer. Ignoring message.`,
        event
      );
      return;
    }
    const message = new Uint8Array(event.data);

    // Push back ping when we receive a message; we know the connection is alive.
    // ping.queue();
    this.#updateConnectionState();

    if (this.#config.verbose) {
      printMessage(message, (data) => {
        this.#debug.log("received message", data);
      });
    }

    switch (getMessageType(message)) {
      case MessageType.Procedure:
        return this.#handleProcedure(message);
      case MessageType.Ack:
        return this.#handleAck(message);
      case MessageType.Ping:
        return this.#handlePing(message);
    }
  };

  async #handleProcedure(message: Uint8Array) {
    const decoded = decodeProcedure(message);
    const impl = this.#procs.get(decoded.name);
    if (!impl) {
      // Respond with an error.
      this.#socket.send(
        encodeAck(
          decoded.ackId,
          false,
          `No implementation for proc '${decoded.name}'`
        )
      );
      return;
    }

    // Empty ackId is a broadcast. No acknowledgement needed.
    if (decoded.ackId === "") {
      try {
        const parsedInput = await impl.proc.parseInput(decoded.input);
        await impl.handler(parsedInput, this);
        this.#debug.log("received broadcast", {
          name: decoded.name,
          input: parsedInput,
        });
      } catch (error) {
        this.#debug.warn("error while handling a broadcast", error);
      }

      return;
    }

    this.#debug.log("received call", {
      ackId: decoded.ackId,
      name: decoded.name,
      input: decoded.input,
    });

    // Handle as a normal procedure call.
    try {
      const parsedInput = await impl.proc.parseInput(decoded.input);
      const output = await impl.handler(parsedInput, this);
      // TODO: Crash on client if output parsing fails.
      const parsedOutput = await impl.proc.parseOutput(output);
      this.#socket.send(encodeAck(decoded.ackId, true, parsedOutput));
    } catch (error) {
      this.#socket.send(encodeAck(decoded.ackId, false, error));
    }
  }

  async #handleAck(message: Uint8Array) {
    const decoded = decodeAck(message);
    const listener = this.#acks.get(decoded.ackId);
    if (!listener) {
      // Received unexpected acknowledgement.
      return;
    }

    if (decoded.success) {
      try {
        const parsedOutput = await listener.proc.parseOutput(decoded.output);
        listener.resolve(parsedOutput);
      } catch (error) {
        if (error instanceof Error) {
          listener.reject(error as Error);
        } else {
          listener.reject(new Error(`Unknown error: ${error}`));
        }
      }
    } else {
      if ((decoded.output as any) instanceof Error) {
        listener.reject(decoded.output as any as Error);
      } else {
        listener.reject(new Error(decoded.output));
      }
    }
  }

  #handlePing(message: Uint8Array) {
    const ackId = decodePing(message);
    this.#socket.send(encodeAck(ackId, true, null));
  }
}
