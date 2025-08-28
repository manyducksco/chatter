import {
  AckIdGenerator,
  type AckListener,
  type Connection,
  decodeAck,
  decodeProc,
  encodeAck,
  PONG_MESSAGE,
  encodeProc,
  getMessageType,
  type Impl,
  type MaybePromise,
  MessageType,
  Proc,
} from "./core";

/**
 * Takes the procedure's input data and a socket object.
 * The `connection` represents a link to the client.
 */
export type ServerProcHandler<I, O, Data> = (
  input: I,
  connection: ServerConnection<Data>
) => MaybePromise<O>;

interface BroadcastOptions {
  exclude?: ServerConnection<any>[];
}

interface ConnectionInfo {
  ws: Bun.ServerWebSocket<undefined>;
}

/**
 * Options passed to the Server constructor.
 */
export interface ServerOptions<Data> {
  /**
   * Called just after the client connects. The return value is set as the `data` field on the connection object.
   */
  getConnectionData?: (info: ConnectionInfo) => Promise<Data>;

  /**
   * Called just after the connection is initialized, but before it starts receiving events.
   */
  onOpen?: (connection: ServerConnection<Data>) => void | Promise<void>;

  /**
   * Called just after the connection is closed.
   */
  onClose?: (
    connection: ServerConnection<Data>,
    code: number,
    reason: string
  ) => void | Promise<void>;
}

class ServerSocketHandler<ConnectionData> implements Bun.WebSocketHandler {
  _server: ChatterServer<ConnectionData>;

  constructor(server: ChatterServer<ConnectionData>) {
    this._server = server;
  }

  open = async (ws: Bun.ServerWebSocket<undefined>) => {
    let connection: ServerConnection<ConnectionData>;

    // Init client
    const opts = this._server._options;
    if (opts.getConnectionData) {
      const data = await opts.getConnectionData({ ws });
      connection = new ServerConnection(this._server, ws, data);
    } else {
      connection = new ServerConnection(this._server, ws, {} as ConnectionData);
    }

    // Ready to receive data now.
    this._server._connections.set(ws, connection);

    if (opts.onOpen) {
      await opts.onOpen(connection);
    }
  };

  close = async (
    ws: Bun.ServerWebSocket<undefined>,
    code: number,
    reason: string
  ) => {
    // Remove client
    const opts = this._server._options;
    const connection = this._server._connections.get(ws);
    if (!connection) return;

    // Unsubscribe from all topics.
    connection._topics.forEach((topic) => connection.unsubscribe(topic));

    // Already disconnected, so we can stop receiving now.
    this._server._connections.delete(ws);

    if (opts.onClose) {
      await opts.onClose(connection, code, reason);
    }
  };

  // ping = async (ws: Bun.ServerWebSocket<undefined>, data: Buffer) => {
  //   const connection = this._server._connections.get(ws);
  //   console.log("ping received", connection);
  // };

  // pong = async (ws: Bun.ServerWebSocket<undefined>, data: Buffer) => {
  //   const connection = this._server._connections.get(ws);
  //   console.log("pong received", connection);
  // };

  drain = async (ws: Bun.ServerWebSocket<undefined>) => {};

  message = async (
    ws: Bun.ServerWebSocket<undefined>,
    data: string | Buffer
  ) => {
    const connection = this._server._connections.get(ws);
    if (connection == null) {
      throw new Error(`No connection found for this socket.`);
    }
    if (typeof data === "string") {
      throw new Error(
        `Expected websocket message to be a Buffer. Got: ${data}`
      );
    }
    const message = new Uint8Array(data);

    // Process incoming message
    switch (getMessageType(message)) {
      case MessageType.Ping:
        return this._handlePing(connection);
      case MessageType.Proc:
        return this._handleProc(connection, message);
      case MessageType.Ack:
        return this._handleAck(connection, message);
    }
  };

  async _handlePing(
    connection: ServerConnection<ConnectionData>
  ): Promise<void> {
    connection._ws.sendBinary(PONG_MESSAGE);
  }

  async _handleProc(
    connection: ServerConnection<ConnectionData>,
    message: Uint8Array
  ): Promise<void> {
    const ws = connection._ws;
    const decoded = decodeProc(message);
    const impl = this._server._procs.get(decoded.name);
    if (!impl) {
      // Respond with an error.
      ws.sendBinary(
        encodeAck(
          decoded.ackId,
          false,
          `No implementation for proc '${decoded.name}'`
        )
      );
      return;
    }

    try {
      const parsedInput = await impl.proc.parseInput(decoded.input);
      const output = await impl.handler(parsedInput, connection);
      const parsedOutput = await impl.proc.parseOutput(output);
      ws.sendBinary(encodeAck(decoded.ackId, true, parsedOutput));
    } catch (error) {
      ws.sendBinary(encodeAck(decoded.ackId, false, error));
    }
  }

  async _handleAck(
    connection: ServerConnection<ConnectionData>,
    message: Uint8Array
  ): Promise<void> {
    const decoded = decodeAck(message);
    const listener = connection._acks.get(decoded.ackId);
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

    connection._acks.delete(decoded.ackId);
  }
}

export function createServer<ConnectionData>(
  options?: ServerOptions<ConnectionData>
): ChatterServer<ConnectionData> {
  return new ChatterServer(options);
}

class ChatterServer<ConnectionData> {
  readonly _options: ServerOptions<ConnectionData>;
  readonly _connections = new Map<
    Bun.ServerWebSocket,
    ServerConnection<ConnectionData>
  >();
  readonly _procs = new Map<
    string,
    Impl<ServerProcHandler<any, any, ConnectionData>>
  >();

  _topicMap = new Map<string, Set<ServerConnection<ConnectionData>>>();

  readonly websocket: ServerSocketHandler<ConnectionData>;

  constructor(options?: ServerOptions<ConnectionData>) {
    this._options = options ?? {};
    this.websocket = new ServerSocketHandler(this);
  }

  /**
   * Implements a `Proc` so it can be called from the other end of the connection.
   */
  on<I, O>(proc: Proc<I, O>, handler: ServerProcHandler<I, O, ConnectionData>) {
    if (this._procs.has(proc.name)) {
      console.warn(
        `Procedure '${proc.name}' has already been added and will be overwritten!`
      );
    }
    this._procs.set(proc.name, { proc, handler });
  }

  /**
   * Calls a procedure on all clients subscribed to `topic`.
   */
  async broadcast(
    topic: string,
    proc: Proc<null, any>,
    input?: null,
    options?: BroadcastOptions
  ): Promise<void>;
  async broadcast<I>(
    topic: string,
    proc: Proc<I, any>,
    input: I,
    options?: BroadcastOptions
  ): Promise<void>;

  /**
   * Calls a procedure on all clients subscribed to any topic in `topics`.
   */
  async broadcast(
    topics: Iterable<string>,
    proc: Proc<null, any>,
    input?: null,
    options?: BroadcastOptions
  ): Promise<void>;
  async broadcast<I>(
    topics: Iterable<string>,
    proc: Proc<I, any>,
    input: I,
    options?: BroadcastOptions
  ): Promise<void>;

  async broadcast<I>(
    topic: string | Iterable<string>,
    proc: Proc<I, any>,
    input?: I,
    options?: BroadcastOptions
  ): Promise<void> {
    const parsedInput = await proc.parseInput(input);

    const source = this._connections.values().next().value;
    if (!source) return;

    // Collect all connections subscribed to any of the given topics.
    const connections = new Set<ServerConnection<ConnectionData>>();
    const topics = new Set<string>(typeof topic === "string" ? [topic] : topic);

    for (const t of topics) {
      const set = this._topicMap.get(t);
      if (set) {
        for (const connection of set) {
          connections.add(connection);
        }
      }
    }

    if (connections.size === 0) {
      return;
    }

    // IDEA: Give server an adapter to broadcast to multiple app instances.

    // Remove excluded connections.
    if (options?.exclude) {
      for (const connection of options.exclude) {
        connections.delete(connection);
      }
    }

    const ackId = ""; // empty ackId means broadcast
    const encoded = encodeProc(proc, ackId, parsedInput);

    // Send encoded message to all sockets.
    for (const connection of connections) {
      connection._ws.sendBinary(encoded);
    }
  }

  /**
   * Returns the first connection for which `where` returns a truthy value.
   */
  find(where: (connection: ServerConnection<ConnectionData>) => any) {
    for (const conn of this._connections.values()) {
      if (where(conn)) {
        return conn;
      }
    }
  }

  /**
   * Returns all connections for which `where` returns a truthy value.
   */
  filter(where: (connection: ServerConnection<ConnectionData>) => any) {
    const matches: ServerConnection<ConnectionData>[] = [];

    for (const conn of this._connections.values()) {
      if (where(conn)) {
        matches.push(conn);
      }
    }

    return matches;
  }
}

export interface ServerConnectionBroadcastOptions extends BroadcastOptions {
  includeSelf?: boolean;
}

/**
 * Represents one client from the server's perspective.
 */
export class ServerConnection<Data> implements Connection {
  _server: ChatterServer<Data>;
  _ws: Bun.ServerWebSocket;
  _topics = new Set<string>();
  _acks = new Map<string, AckListener>();
  _ids = new AckIdGenerator();
  _pingTimer: any;
  _staleTimer: any;
  _pingInterval = 30;

  data: Data;

  constructor(
    server: ChatterServer<Data>,
    ws: Bun.ServerWebSocket,
    data: Data
  ) {
    this._server = server;
    this._ws = ws;
    this.data = data;
  }

  /**
   * Calls a procedure on the client and returns its response.
   */
  async call<O>(proc: Proc<null, O>): Promise<O>;
  async call<I, O>(proc: Proc<I, O>, input: I): Promise<O>;
  async call<I, O>(proc: Proc<I, O>, input?: I): Promise<O> {
    // Parse input data
    const parsedInput = await proc.parseInput(input);

    let timer: any;
    const waitTime = proc.timeout;

    return new Promise<O>(async (resolve, reject) => {
      const ackId = this._ids.next();
      const listener: AckListener = {
        proc,
        timestamp: Date.now(),
        resolve,
        reject,
      };
      this._acks.set(ackId, listener);

      // Configure timeout
      timer = setTimeout(() => {
        listener.reject(
          new Error(`Procedure call timed out after ${waitTime}ms`)
        );
        this._acks.delete(ackId);
      }, waitTime);

      // Send over _ws, await acknowledgement.
      this._ws.sendBinary(encodeProc(proc, ackId, parsedInput));
    }).finally(() => {
      clearTimeout(timer);
    });
  }

  /**
   * Calls a procedure on all clients subscribed to `topic`.
   * Excludes this client unless `options.includeSelf` is true.
   */
  broadcast(
    topic: string,
    proc: Proc<null, any>,
    input?: null,
    options?: ServerConnectionBroadcastOptions
  ): Promise<void>;
  broadcast<I>(
    topic: string,
    proc: Proc<I, any>,
    input: I,
    options?: ServerConnectionBroadcastOptions
  ): Promise<void>;

  /**
   * Calls a procedure on all clients subscribed to any topic in `topics`.
   * Excludes this client unless `options.includeSelf` is true.
   */
  broadcast(
    topics: Iterable<string>,
    proc: Proc<null, any>,
    input?: null,
    options?: ServerConnectionBroadcastOptions
  ): Promise<void>;
  broadcast<I>(
    topics: Iterable<string>,
    proc: Proc<I, any>,
    input: I,
    options?: ServerConnectionBroadcastOptions
  ): Promise<void>;

  broadcast<I>(
    topic: string | Iterable<string>,
    proc: Proc<I, any>,
    input?: I,
    options?: ServerConnectionBroadcastOptions
  ): Promise<void> {
    return this._server.broadcast(topic, proc, input, {
      ...options,
      exclude: options?.includeSelf === true ? undefined : [this],
    });
  }

  /**
   * Subscribes this connection to `topic`.
   */
  subscribe(topic: string) {
    this._topics.add(topic);
    const set = this._server._topicMap.get(topic);
    if (!set) {
      this._server._topicMap.set(topic, new Set([this]));
    } else {
      set.add(this);
    }
  }

  /**
   * Unsubscribes this connection from `topic`.
   */
  unsubscribe(topic: string) {
    this._topics.delete(topic);
    this._server._topicMap.get(topic)?.delete(this);
  }

  isSubscribed(topic: string): boolean {
    return this._topics.has(topic);
  }

  _destroy() {
    clearTimeout(this._pingTimer);
  }
}
