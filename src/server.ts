import { input } from "zod";
import { fromZodError } from "zod-validation-error";
import {
  type ProcedureOptions,
  type SocketConfig,
  type SocketSchema,
  createIdGenerator,
  decodeAck,
  decodePing,
  decodeProcedure,
  encodeAck,
  encodeProcedure,
  getMessageType,
  MessageType,
  printMessage,
} from "./core";
import { Emitter, EventMap } from "@manyducks.co/emitter";

export type ClientData = Record<string, any>;

interface ServerEvents<S extends SocketSchema> extends EventMap {
  connect: [SocketServerClient<S>];
  disconnect: [SocketServerClient<S>];
}

export type SocketServer<S extends SocketSchema> = {
  handler: Bun.WebSocketHandler<any>;
  events: Emitter<ServerEvents<S>>;
  clientsWhere: (match: (data: ClientData, index: number) => boolean) => SocketServerClient<S>[];
  publish<P extends keyof S["client"]>(
    topic: string,
    name: P,
    input: S["client"][P]["input"] extends undefined
      ? undefined
      : input<Exclude<S["client"][P]["input"], undefined>>,
  ): void;
};

interface AckListener {
  proc: string;
  resolve(output: any): void;
  reject(error: Error): void;
}

/**
 * Represents a single websocket connection to a client.
 */
export class SocketServerClient<S extends SocketSchema> {
  _ws;
  _config;
  _ackListeners = new Map<string, AckListener>();
  _topics = new Set<string>();

  /**
   * An object to store any values you want.
   * Can be filtered to retrieve a list of matching clients.
   */
  data: ClientData = {};

  _getId = createIdGenerator();

  constructor(ws: Bun.ServerWebSocket<any>, config: SocketServerConfig<S>) {
    this._ws = ws;
    this._config = config;
  }

  /**
   * Call a procedure on the client.
   */
  async call<P extends keyof S["client"]>(
    name: P,
    input: S["client"][P]["input"] extends undefined
      ? undefined
      : input<Exclude<S["client"][P]["input"], undefined>>,
    options?: ProcedureOptions,
  ): Promise<
    S["client"][P]["output"] extends undefined
      ? undefined
      : input<Exclude<S["client"][P]["output"], undefined>>
  > {
    let timeout: any;
    const timeoutMs = options?.timeout ?? this._config.defaultTimeout ?? 5000;
    return new Promise<any>((resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Procedure call timed out after ${timeoutMs}`));
      }, timeoutMs);
      const ackId = this._getId();
      this._ackListeners.set(ackId, { proc: name as string, resolve, reject });
      this._ws.sendBinary(encodeProcedure(ackId, name as string, input));
    }).finally(() => {
      clearTimeout(timeout);
    });
  }

  subscribe(topic: string) {
    this._ws.subscribe(topic);
    this._topics.add(topic);
  }

  unsubscribe(topic: string) {
    this._ws.unsubscribe(topic);
    this._topics.delete(topic);
  }

  publish<P extends keyof S["client"]>(
    topic: string,
    name: P,
    input: S["client"][P]["input"] extends undefined
      ? undefined
      : input<Exclude<S["client"][P]["input"], undefined>>,
  ): void {
    // empty ackId is a broadcast.
    const ackId = "";

    // Publish to all subscribed sockets besides this one.
    this._ws.publishBinary(topic, encodeProcedure(ackId, name as string, input));
  }
}

export type ServerProcedure<S extends SocketSchema, K extends keyof S["server"]> = (
  input: S["server"][K]["input"] extends undefined
    ? void
    : input<Exclude<S["server"][K]["input"], undefined>>,
  client: SocketServerClient<S>,
) =>
  | Promise<
      S["server"][K]["output"] extends undefined ? void : input<Exclude<S["server"][K]["output"], undefined>>
    >
  | (S["server"][K]["output"] extends undefined ? void : input<Exclude<S["server"][K]["output"], undefined>>);

export interface SocketServerConfig<S extends SocketSchema> extends SocketConfig<S> {
  procedures: {
    [K in keyof S["server"]]: ServerProcedure<S, K>;
  };
}

export function createServer<S extends SocketSchema>(config: SocketServerConfig<S>): SocketServer<S> {
  const clients = new Map<Bun.ServerWebSocket<any>, SocketServerClient<S>>();
  const events = new Emitter<ServerEvents<S>>();

  const debug = {
    log(...args: any) {
      if (config.verbose) {
        console.log(`[⚡socket]`, ...args);
      }
    },
    warn(...args: any) {
      if (config.verbose) {
        console.warn(`[⚡socket]`, ...args);
      }
    },
    error(...args: any) {
      console.error(`[⚡socket]`, ...args);
    },
  };

  return {
    events,

    publish(topic, name, input) {
      // Get websocket instance from first client.
      const client = clients.values().next().value;
      if (client) {
        const ws = client._ws;
        if (ws) {
          // Publish to all topic subscribers.
          const ackId = "";
          const proc = encodeProcedure(ackId, name as string, input);

          ws.publishBinary(topic, proc);

          // Also send to the client, if subscribed.
          if (ws.isSubscribed(topic)) {
            ws.sendBinary(proc);
          }

          // TODO: If we had a reference to the Bun server here could we just server.publish?.
        }
      }
    },

    /**
     * Returns a list of clients for which `match` returns true.
     * The match function takes the client's `data` object and returns a boolean.
     */
    clientsWhere: (match) => {
      const matches: SocketServerClient<S>[] = [];
      let i = 0;
      for (const [ws, client] of clients) {
        if (match(client.data, i++)) {
          matches.push(client);
        }
      }
      return matches;
    },

    handler: {
      async open(ws) {
        const client = new SocketServerClient(ws, config);
        clients.set(ws, client);
        events.emit("connect", client);
        debug.log("client connected");
      },
      close(ws, code, reason) {
        const client = clients.get(ws)!;

        // Reject all still-waiting acks when the connection is closed.
        for (const listener of client._ackListeners.values()) {
          listener.reject(new Error(`Client disconnected.`));
        }

        events.emit("disconnect", client);
        clients.delete(ws);
        debug.log("client disconnected", { code, reason });
      },
      async message(ws, data) {
        const client = clients.get(ws);
        if (client == null) {
          throw new Error(`No client found for websocket connection`);
        }
        if (typeof data === "string") {
          debug.warn("Expected websocket message to be a Buffer:", data);
          return;
        }
        const message = new Uint8Array(data);

        if (config.verbose) {
          printMessage(message, (data) => {
            debug.log("received message", data);
          });
        }

        switch (getMessageType(message)) {
          case MessageType.Procedure: {
            const proc = decodeProcedure(message);
            const handler = config.procedures[proc.name];
            const schema = config.schema.server[proc.name];
            let input;
            if (schema.input) {
              const { success, data, error } = await schema.input.safeParseAsync(proc.input);
              if (success) {
                input = data;
              } else {
                const e = fromZodError(error).message;
                debug.error(e);
                // Acknowledge failure
                ws.sendBinary(encodeAck(proc.ackId, false, e));
              }
            }

            try {
              const output = await handler(input as any, client);
              if (schema.output) {
                const { success, data, error } = schema.output.safeParse(output);
                if (success) {
                  ws.sendBinary(encodeAck(proc.ackId, true, data));
                } else {
                  debug.warn("bad output", fromZodError(error));
                  throw new Error(`Bad handler output: ${fromZodError(error).toString()}`);
                }
              } else {
                ws.sendBinary(encodeAck(proc.ackId, true, undefined));
              }
            } catch (error) {
              // Acknowledge failure.
              ws.sendBinary(encodeAck(proc.ackId, false, error));
            }

            break;
          }
          case MessageType.Ack: {
            const { ackId, success, output } = decodeAck(message);
            const listener = client._ackListeners.get(ackId);
            if (listener) {
              if (success) {
                const outputSchema = config.schema.client[listener.proc]?.output;
                if (outputSchema) {
                  const { success, data, error } = outputSchema.safeParse(output);
                  if (success) {
                    listener.resolve(data);
                  } else {
                    listener.reject(error);
                  }
                }
                listener.resolve(undefined);
              } else {
                listener.reject(new Error(output));
              }
              client._ackListeners.delete(ackId);
            } else {
              // TODO: Handle missing listener?
              debug.warn(`Received unexpected ack for ackId '${ackId}'`);
            }
            break;
          }
          case MessageType.Ping: {
            const ackId = decodePing(message);
            ws.sendBinary(encodeAck(ackId, true, undefined));
            break;
          }
        }
      },
      // drain(ws) {},
    },
  };
}
