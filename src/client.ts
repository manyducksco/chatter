import { nanoid } from "nanoid";
import {
  AckIdGenerator,
  type AckListener,
  AckResponseCache,
  type Connection,
  decodeAck,
  decodeBroadcast,
  decodeProc,
  encodeAck,
  encodeProc,
  getMessageType,
  type Impl,
  MessageType,
  PING_MESSAGE,
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

  /**
   * Number of seconds to wait after the most recent message was received before sending a ping message.
   * Pings are used to keep the connection alive and check that we can communicate with the server.
   * Default is 30 seconds.
   */
  pingInterval?: number;
}

export enum ConnectionState {
  /**
   * The initial state. No active connection to the server.
   */
  Disconnected,

  /**
   * A connection is being established. No active connection yet.
   */
  Connecting,

  /**
   * Server connection is active and ready to send and receive.
   */
  Connected,

  /**
   * Connection liveness needs to be checked and possibly reconnected.
   */
  Unknown,
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
  #sessionId = nanoid();

  #state = ConnectionState.Disconnected;
  #stateChangeCallbacks = new Set<(state: ConnectionState) => void>();

  #procs = new Map<string, Impl<ClientProcHandler<any, any>>>();

  #socket!: WebSocket;
  #reconnectAttempts = 0;
  #reconnectTimeout: any;
  #pingTimer: any;
  #pongTimer: any;
  #pingInterval = 30;

  #ackIds = new AckIdGenerator();
  #ackListeners = new Map<string, AckListener>();

  /**
   * Cached acknowledgements to be re-sent on reconnect.
   */
  #ackResponses = new AckResponseCache();

  /**
   * Cached messages that couldn't be sent while offline. To be sent when socket comes online.
   */
  #offlineMessageQueue: Uint8Array[] = [];

  #debug: Logger;

  #lastPingSentAt?: number;

  constructor(config: ClientConfig) {
    this.#config = config;
    this.#debug = createLogger(config.verbose);

    if (config.pingInterval) this.#pingInterval = config.pingInterval;

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
   * Persistent client ID. Stored in localStorage to persist between sessions.
   */
  get clientId() {
    return this.#clientId;
  }

  /**
   * Ephemeral session ID. Regenerated each time the page is loaded.
   */
  get sessionId() {
    return this.#sessionId;
  }

  /**
   * True when the socket is open and ready.
   */
  get isConnected() {
    return this.#state === ConnectionState.Connected;
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
  async call<O>(proc: Proc<null, O>, input: null): Promise<O>;
  async call<I, O>(proc: Proc<I, O>, input: I): Promise<O>;
  async call<I, O>(proc: Proc<I, O>, input?: I): Promise<O> {
    const parsedInput = await proc.parseInput(input);

    let timer: any;
    const waitTime = proc.timeout;

    return new Promise<O>((resolve, reject) => {
      const ackId = this.#ackIds.next();
      const listener: AckListener = {
        proc,
        timestamp: Date.now(),
        resolve: (output) => {
          this.#debug.log("call succeeded", {
            ackId,
            name: proc.name,
            input: parsedInput,
            output,
            elapsed: Date.now() - listener.timestamp,
          });
          resolve(output);
        },
        reject: (error) => {
          this.#debug.warn("call failed", {
            ackId,
            name: proc.name,
            input: parsedInput,
            error,
            elapsed: Date.now() - listener.timestamp,
          });
          reject(error);
        },
      };
      this.#ackListeners.set(ackId, listener);

      // Configure timeout
      timer = setTimeout(() => {
        listener.reject(
          new Error(`Procedure call timed out after ${waitTime}ms.`)
        );
        this.#ackListeners.delete(ackId);
      }, waitTime);

      const message = encodeProc(proc, ackId, parsedInput);

      if (this.#socket.readyState !== WebSocket.OPEN || !this.isConnected) {
        this.#debug.warn(
          `Socket is offline; queuing call to send when connection is ready.`
        );
        this.#offlineMessageQueue.push(message);
      } else {
        this.#socket.send(message);
      }
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
      stored = nanoid();
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
        return this.#setConnectionState(ConnectionState.Connected);
      }
      this.#socket.close();
    }

    const url = this.#withSearchParams(this.#config.url, {
      cid: this.#clientId,
      sid: this.#sessionId,
    });
    this.#socket = new WebSocket(url);
    this.#socket.binaryType = "arraybuffer";
    this.#socket.addEventListener("open", this.#onOpen);
    this.#socket.addEventListener("close", this.#onClose);
    this.#socket.addEventListener("message", this.#onMessage);
    this.#socket.addEventListener("error", this.#onError);
  }

  #withSearchParams(url: string | URL, params: Record<string, string>): string {
    const str = url instanceof URL ? url.toString() : url;
    const [base, search] = str.split("?");
    const searchParams = new URLSearchParams(search);
    for (const key in params) {
      searchParams.set(key, params[key]);
    }
    return base + "?" + searchParams.toString();
  }

  #setConnectionState(state: ConnectionState) {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      state = ConnectionState.Disconnected;
    }

    if (state !== this.#state) {
      this.#state = state;
      for (const callback of this.#stateChangeCallbacks) {
        callback(state);
      }
    }
  }

  #tryReconnect() {
    // If document is hidden we will attempt reconnect when it becomes visible again.
    if (this.#reconnectTimeout != null || document.visibilityState === "hidden")
      return;

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
    if (document.visibilityState === "visible") {
      if (this.#socket.readyState === WebSocket.OPEN) {
        this.#pingCheck();
      } else {
        this.#connect();
      }
    } else {
      this.#setConnectionState(ConnectionState.Unknown);
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

  #clearPing() {
    clearTimeout(this.#pingTimer);
  }

  #queuePing() {
    this.#clearPing();

    // Send pings on a timer. If we don't receive a pong message in response within 5 seconds we should reconnect.
    this.#pingTimer = setTimeout(() => {
      this.#lastPingSentAt = performance.now();
      this.#socket.send(PING_MESSAGE);
      this.#pongTimer = setTimeout(() => {
        this.#socket.close(); // should trigger reconnect
      }, 5 * 1000);
    }, this.#pingInterval * 1000);
  }

  /**
   * Tries pinging the server to see if we're online.
   * If we are the connection state will be set to Connected when PONG is received.
   */
  #pingCheck() {
    this.#clearPing();
    this.#lastPingSentAt = performance.now();
    this.#socket.send(PING_MESSAGE);
    this.#pongTimer = setTimeout(() => {
      this.#socket.close(); // should trigger reconnect
    }, 2 * 1000); // wait only 2 seconds
  }

  #onOpen = (event: Event) => {
    this.#debug.log("Socket connected.");

    window.addEventListener("beforeunload", this.#beforeUnload);

    // NOTE: Connection state will be set when READY_MESSAGE is received.

    this.#reconnectAttempts = 0;
    this.#queuePing();
  };

  #onClose = (event: CloseEvent) => {
    this.#debug.warn("Socket closed.");

    window.removeEventListener("beforeunload", this.#beforeUnload);

    this.#setConnectionState(ConnectionState.Disconnected);
    this.#clearPing();
    this.#tryReconnect();
  };

  #onError = (event: Event) => {
    event.preventDefault();

    this.#debug.error("Socket error", event);

    window.removeEventListener("beforeunload", this.#beforeUnload);

    this.#setConnectionState(ConnectionState.Disconnected);
    this.#clearPing();
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

    // We must be connected if we're receiving messages.
    this.#setConnectionState(ConnectionState.Connected);
    this.#queuePing();

    switch (getMessageType(message)) {
      case MessageType.Ready:
        return this.#handleReady();
      case MessageType.Pong:
        return this.#handlePong();
      case MessageType.Broadcast:
        return this.#handleBroadcast(message);
      case MessageType.Proc:
        return this.#handleProc(message);
      case MessageType.Ack:
        return this.#handleAck(message);
    }
  };

  async #handleReady() {
    this.#debug.log("received ready");

    let sentAcks = 0;
    let sentMessages = 0;

    // Send cached acks
    for (const [ackId, message] of this.#ackResponses.entries()) {
      this.#socket.send(message);
      sentAcks++;
    }

    // Send messages created while offline
    for (const message of this.#offlineMessageQueue) {
      this.#socket.send(message);
      sentMessages++;
    }
    this.#offlineMessageQueue.length = 0;

    this.#debug.log(
      `ready: sent ${sentAcks} ack(s), ${sentMessages} message(s)`
    );
  }

  async #handlePong() {
    // Prevent connection close when pong is received before the timer completes.
    clearTimeout(this.#pongTimer);

    const timing =
      performance.now() - (this.#lastPingSentAt ?? performance.now());
    this.#debug.log(`received pong in ${timing}ms`);
  }

  async #handleBroadcast(message: Uint8Array) {
    const decoded = decodeBroadcast(message);
    const impl = this.#procs.get(decoded.name);
    if (!impl) return;

    this.#debug.log("received broadcast", {
      name: decoded.name,
      input: decoded.input,
    });

    try {
      const parsedInput = await impl.proc.parseInput(decoded.input);
      await impl.handler(parsedInput, this);
    } catch (error) {
      this.#debug.warn("error while handling a broadcast", error);
    }
  }

  async #handleProc(message: Uint8Array) {
    const decoded = decodeProc(message);
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

    this.#debug.log("received call", {
      ackId: decoded.ackId,
      name: decoded.name,
      input: decoded.input,
    });

    try {
      const parsedInput = await impl.proc.parseInput(decoded.input);
      const output = await impl.handler(parsedInput, this);
      const parsedOutput = await impl.proc.parseOutput(output);

      // Cache ack until proc timeout in case of connection failure.
      const ack = encodeAck(decoded.ackId, true, parsedOutput);
      this.#ackResponses.set(impl.proc, decoded.ackId, ack);
      this.#socket.send(ack);
    } catch (error) {
      const ack = encodeAck(decoded.ackId, false, error);
      this.#ackResponses.set(impl.proc, decoded.ackId, ack);
      this.#socket.send(ack);
    }
  }

  async #handleAck(message: Uint8Array) {
    const decoded = decodeAck(message);
    const listener = this.#ackListeners.get(decoded.ackId);
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

    this.#ackListeners.delete(decoded.ackId);
  }
}
