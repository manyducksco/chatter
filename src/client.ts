import { input } from "zod";
import {
  createIdGenerator,
  decodeAck,
  decodePing,
  decodeProcedure,
  encodeAck,
  encodePing,
  encodeProcedure,
  getMessageType,
  MessageType,
  printMessage,
  type ProcDefinition,
  type ProcedureOptions,
  type ProcMap,
  type SocketConfig,
  type SocketSchema,
} from "./core";
import { Debouncer } from "./debouncer";

export enum ConnectionState {
  Online,
  Offline,
}

export type SocketClient<S extends SocketSchema> = {
  readonly connectionState: ConnectionState;
  onConnectionStateChanged: (
    callback: (state: ConnectionState) => void
  ) => () => void;

  /**
   * Call a procedure on the server.
   */
  call<P extends keyof S["server"]>(
    name: P,
    input: S["server"][P]["input"] extends undefined
      ? undefined
      : input<Exclude<S["server"][P]["input"], undefined>>,
    options?: ProcedureOptions
  ): Promise<
    S["server"][P]["output"] extends undefined
      ? undefined
      : input<Exclude<S["server"][P]["output"], undefined>>
  >;
};
//& { [K in keyof S["server"]]: ProcedureMethod<S["server"][K]> };

export type ClientProcedure<D extends ProcDefinition> = (
  input: D["input"] extends undefined
    ? void
    : input<Exclude<D["input"], undefined>>
) =>
  | Promise<
      D["output"] extends undefined
        ? void
        : input<Exclude<D["output"], undefined>>
    >
  | (D["output"] extends undefined
      ? void
      : input<Exclude<D["output"], undefined>>);

export interface SocketClientConfig<S extends SocketSchema, P extends ProcMap>
  extends SocketConfig<S> {
  url: string;
  procedures: {
    [K in keyof P]: ClientProcedure<P[K]>;
  };
  /**
   * Time to wait (in milliseconds) after the last message to send a ping.
   * Defaults to `30000` (30 seconds).
   */
  pingInterval?: number;
}

const noop = () => {};

export function createClient<S extends SocketSchema>(
  config: SocketClientConfig<S, S["client"]>
): SocketClient<S> {
  let socket!: WebSocket;
  let reconnectAttempts = 0;
  let reconnectTimeout: any;
  let connectionState = ConnectionState.Offline;
  const connectionStateChangeListeners: ((state: ConnectionState) => void)[] =
    [];

  const defaultTimeout = config.defaultTimeout ?? 5000;
  const getId = createIdGenerator();

  const debug = {
    get log() {
      if (!config.verbose) return noop;
      return console.log.bind(console, "[chatter]");
    },
    get warn() {
      if (!config.verbose) return noop;
      return console.warn.bind(console, "[chatter]");
    },
    get error() {
      if (!config.verbose) return noop;
      return console.error.bind(console, "[chatter]");
    },
  };

  // Acknowledgements the client is waiting on from the server.
  const ackListeners = new Map<string, AckListener>();
  interface AckListener {
    proc: string;
    resolve: (output: any) => void;
    reject: (error: Error) => void;
  }

  const ping = new Debouncer(config.pingInterval ?? 30_000, () => {
    let timeout: any;
    new Promise((resolve, reject) => {
      // 10 second timeout
      timeout = setTimeout(() => {
        reject(new Error("Ping timed out."));
      }, 10_000);
      const ackId = getId();
      ackListeners.set(ackId, { proc: "@ping", resolve, reject });
      socket.send(encodePing(ackId));
    })
      .then(() => {
        // Connection is still online. Check again in 60 seconds.
        ping.queue();
      })
      .catch((error) => {
        debug.error(error);
      })
      .finally(() => {
        clearTimeout(timeout);
        updateConnectionState();
      });
  });

  function connect() {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;

    // No-op if already connected.
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        return setConnectionState(ConnectionState.Online);
      }
      socket.close();
    }

    socket = new WebSocket(config.url);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onClose);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  }

  function tryReconnect() {
    if (reconnectTimeout == null) {
      // Reconnect with exponential backoff (max 30 seconds)
      const delay = Math.min(1000 * 2 ** reconnectAttempts++, 30000);
      reconnectTimeout = setTimeout(connect, delay);

      if (reconnectAttempts > 0) {
        debug.log(
          `Attempting socket reconnection in ${delay / 1000} seconds (attempt ${reconnectAttempts}).`
        );
      } else {
        debug.log(`Attempting socket connection.`);
      }
    }
  }

  function setConnectionState(state: ConnectionState) {
    if (state !== connectionState) {
      connectionState = state;
      for (const callback of connectionStateChangeListeners) {
        callback(state);
      }

      if (connectionState === ConnectionState.Offline) {
        // Reject all pending listeners.
        for (const [id, listener] of Array.from(ackListeners.entries())) {
          listener.reject(new Error(`Socket disconnected.`));
          ackListeners.delete(id);
        }
      }
    }
  }

  function updateConnectionState() {
    if (socket.readyState === WebSocket.OPEN) {
      setConnectionState(ConnectionState.Online);
    } else {
      setConnectionState(ConnectionState.Offline);
    }
  }

  function beforeUnload() {
    // Graceful shutdown if the user leaves the page.
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1000, "App unloaded");
    }
  }

  function onOpen(event: Event) {
    // debug.log("event: open", event);
    debug.log("Socket connected.");

    updateConnectionState();
    window.addEventListener("beforeunload", beforeUnload);
    reconnectAttempts = 0;
    // clearTimeout(reconnectTimeout);

    ping.queue();
  }

  function onClose(event: CloseEvent) {
    // debug.log("event: close", event);
    debug.warn("Socket closed.");

    updateConnectionState();
    window.removeEventListener("beforeunload", beforeUnload);

    ping.cancel();

    tryReconnect();
  }

  async function onMessage(event: MessageEvent) {
    // All messages are encoded as Uint8Arrays.
    if (!(event.data instanceof ArrayBuffer)) {
      debug.warn(
        `Message data was not an ArrayBuffer. Ignoring message.`,
        event
      );
      return;
    }
    const message = new Uint8Array(event.data);

    // Push back ping when we receive a message; we know the connection is alive.
    ping.queue();
    updateConnectionState();

    if (config.verbose) {
      printMessage(message, (data) => {
        debug.log("received message", data);
      });
    }

    switch (getMessageType(message)) {
      case MessageType.Procedure: {
        const proc = decodeProcedure(message);
        const handler = config.procedures[proc.name];
        const schema = config.schema.client[proc.name];
        let input;
        if (schema.input) {
          try {
            input = schema.input.parse(proc.input);
          } catch (error) {
            // Acknowledge failure
            socket.send(encodeAck(proc.ackId, false, error));
          }
        }

        // Empty ackId is a broadcast. No acknowledgement needed.
        if (proc.ackId === "") {
          await handler(input as any);
          debug.log("received broadcast", { name: proc.name, input });
          break;
        }

        let output;
        try {
          output = await handler(input as any);
          if (schema.output) {
            try {
              const data = schema.output.parse(output);
              socket.send(encodeAck(proc.ackId, true, data));
              debug.log("received call", {
                ackId: proc.ackId,
                name: proc.name,
                input: data,
              });
            } catch (error) {
              socket.send(encodeAck(proc.ackId, false, error));
              debug.log("received call", {
                ackId: proc.ackId,
                name: proc.name,
                error,
              });
            }
          } else {
            socket.send(encodeAck(proc.ackId, true, undefined));
            debug.log("received call", {
              ackId: proc.ackId,
              name: proc.name,
              input,
              output: undefined,
            });
          }
        } catch (error) {
          // Acknowledge failure
          socket.send(encodeAck(proc.ackId, false, error));
        }

        break;
      }
      case MessageType.Ack: {
        const { ackId, success, output, error } = decodeAck(message);

        const listener = ackListeners.get(ackId);
        if (listener) {
          if (success) {
            const outputSchema = config.schema.server[listener.proc]?.output;
            if (outputSchema) {
              const { success, data, error } = outputSchema.safeParse(output);
              if (success) {
                listener.resolve(data);
              } else {
                listener.reject(error);
              }
            } else {
              listener.resolve(undefined);
            }
          } else {
            console.warn(error);
            listener.reject(new Error(error));
          }
          ackListeners.delete(ackId);
        } else {
          // TODO: Handle acknowledgement for a message that wasn't waiting on one. Warn?
        }
        break;
      }
      case MessageType.Ping: {
        const ackId = decodePing(message);
        socket.send(encodeAck(ackId, true, undefined));
        break;
      }
    }
  }

  function onError(event: Event) {
    event.preventDefault();

    debug.error("event: error", event);

    updateConnectionState();
    window.removeEventListener("beforeunload", beforeUnload);

    ping.cancel();

    tryReconnect();
  }

  // Handle reconnection when someone comes back to the app.
  function onVisibilityChange(_: Event) {
    if (
      document.visibilityState === "visible" &&
      socket.readyState !== WebSocket.OPEN
    ) {
      connect();
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  function onNetworkChange(_: Event) {
    if (navigator.onLine) {
      connect();
    } else {
      // TODO: Disconnect?
    }
  }
  window.addEventListener("online", onNetworkChange);
  window.addEventListener("offline", onNetworkChange);

  // Create initial connection.
  connect();

  return {
    get connectionState() {
      return connectionState;
    },
    onConnectionStateChanged(callback: (state: ConnectionState) => void) {
      connectionStateChangeListeners.push(callback);
      return () => {
        connectionStateChangeListeners.splice(
          connectionStateChangeListeners.indexOf(callback),
          1
        );
      };
    },
    async call(name: string, input, options) {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Socket is not open.");
      }

      const inputSchema = config.schema.server[name].input;

      // Parse input data with schema before sending. If no schema is provided, no data is passed.
      let inputData: any;
      if (inputSchema) {
        inputData = inputSchema.parse(input);
      }

      const timeoutMs = options?.timeout ?? defaultTimeout;
      let timeout: any;

      return new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Procedure call timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        const startTime = Date.now();
        const ackId = getId();
        ackListeners.set(ackId, {
          proc: name,
          resolve: (output) => {
            debug.log("call succeeded", {
              ackId,
              name,
              input: inputData,
              output,
              elapsed: Date.now() - startTime,
            });
            resolve(output);
          },
          reject: (error) => {
            debug.warn("call failed", {
              ackId,
              name,
              input: inputData,
              error,
              elapsed: Date.now() - startTime,
            });
            reject(error);
          },
        });
        socket.send(encodeProcedure(ackId, name, inputData));
      }).finally(() => {
        clearTimeout(timeout);
      });
    },
  } as SocketClient<S>;
}
