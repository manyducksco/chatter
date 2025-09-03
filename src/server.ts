import {
  AckIdGenerator,
  type AckListener,
  AckResponseCache,
  type Connection,
  decodeAck,
  decodeProc,
  encodeAck,
  encodeProc,
  getMessageType,
  READY_MESSAGE,
  type Impl,
  type MaybePromise,
  MessageType,
  PONG_MESSAGE,
  Proc,
  encodeBroadcast,
} from "./core";

/**
 * Takes the procedure's input data and a socket object.
 * The `connection` represents a link to the client.
 */
export type ServerProcHandler<I, O, Data> = (
  input: I,
  connection: ServerConnection<Data>
) => MaybePromise<O>;

export interface BroadcastOptions {
  exclude?: ServerConnection<any>[];
}

interface SocketData {
  req: Request;
  clientId: string;
  sessionId: string;
  meta: Record<any, any>;
}

/**
 * Options passed to the Server constructor.
 */
export interface ServerOptions<Data> {
  /**
   * Called just after the client connects. The return value is set as the `data` field on the connection object.
   */
  getConnectionData?: (ws: Bun.ServerWebSocket<SocketData>) => Promise<Data>;

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

interface HandshakeAckListener {
  ws: Bun.ServerWebSocket<undefined>;
}

class ServerSocketHandler<ConnectionData>
  implements Bun.WebSocketHandler<SocketData>
{
  _server: ChatterServer<ConnectionData>;

  constructor(server: ChatterServer<ConnectionData>) {
    this._server = server;
  }

  open = async (ws: Bun.ServerWebSocket<SocketData>) => {
    const { sessionId } = ws.data;

    const current = this._server._connections.get(sessionId);
    if (current) {
      // Point current connection to new socket.
      await current._reconnect(ws);
      ws.sendBinary(READY_MESSAGE);
    } else {
      // Otherwise init new.
      let connection: ServerConnection<ConnectionData>;

      const opts = this._server._options;
      if (opts.getConnectionData) {
        const data = await opts.getConnectionData(ws);
        connection = new ServerConnection(this._server, ws, data);
      } else {
        const data = {} as ConnectionData;
        connection = new ServerConnection(this._server, ws, data);
      }

      this._server._connections.set(sessionId, connection);

      if (opts.onOpen) {
        await opts.onOpen(connection);
      }

      // Let the client know we're ready.
      ws.sendBinary(READY_MESSAGE);
    }
  };

  close = async (
    ws: Bun.ServerWebSocket<SocketData>,
    code: number,
    reason: string
  ) => {
    // Remove client
    const opts = this._server._options;

    const connection = this._server._connections.get(ws.data.sessionId);

    if (!connection) return;

    connection._disconnect();

    // Unsubscribe from all topics.
    // connection._topics.forEach((topic) => connection.unsubscribe(topic));

    // Already disconnected, so we can stop receiving now.
    // this._server._connections.delete(ws);

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

  drain = async (ws: Bun.ServerWebSocket<SocketData>) => {};

  message = async (
    ws: Bun.ServerWebSocket<SocketData>,
    data: string | Buffer
  ) => {
    if (typeof data === "string") {
      throw new Error(
        `Expected websocket message to be a Buffer. Got: ${data}`
      );
    }

    const connection = this._server._connections.get(ws.data.sessionId);
    if (connection == null) {
      throw new Error(`No connection found for this socket.`);
    }

    const message = new Uint8Array(data);
    const type = getMessageType(message);

    // Process incoming message
    switch (type) {
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

      // Cache message in case of connection failure.
      const message = encodeAck(decoded.ackId, true, parsedOutput);
      connection._ackResponses.set(impl.proc, decoded.ackId, message);
      ws.sendBinary(message);
      // TODO: Use return value of sendBinary to decide if we need to cache it?
    } catch (error) {
      const message = encodeAck(decoded.ackId, false, error);
      connection._ackResponses.set(impl.proc, decoded.ackId, message);
      ws.sendBinary(message);
    }
  }

  async _handleAck(
    connection: ServerConnection<ConnectionData>,
    message: Uint8Array
  ): Promise<void> {
    const decoded = decodeAck(message);
    const listener = connection._ackListeners.get(decoded.ackId);
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

    connection._ackListeners.delete(decoded.ackId);
  }
}

export function createServer<ConnectionData>(
  options?: ServerOptions<ConnectionData>
): ChatterServer<ConnectionData> {
  return new ChatterServer(options);
}

class ChatterServer<ConnectionData> {
  readonly _options: ServerOptions<ConnectionData>;
  readonly _connections = new Map<string, ServerConnection<ConnectionData>>();
  readonly _procs = new Map<
    string,
    Impl<ServerProcHandler<any, any, ConnectionData>>
  >();

  _topicMap = new Map<string, Set<ServerConnection<ConnectionData>>>();

  constructor(options?: ServerOptions<ConnectionData>) {
    this._options = options ?? {};
    this.websocket = new ServerSocketHandler(this);
  }

  readonly websocket: ServerSocketHandler<ConnectionData>;

  /**
   * @param req - The request object.
   * @param server - The Bun server object.
   * @param meta - An optional object with values that will be accessible in `getConnectionData`.
   */
  async upgrade(
    req: Request,
    server: Bun.Server,
    meta?: Record<any, any>
  ): Promise<Response | undefined> {
    const params = new URLSearchParams(req.url.split("?")[1]);

    const clientId = params.get("cid");
    const sessionId = params.get("sid");

    if (!clientId) {
      return Response.json(
        { message: "Missing `cid` search param." },
        { status: 400 }
      );
    }

    if (!sessionId) {
      return Response.json(
        { message: "Missing `sid` search param." },
        { status: 400 }
      );
    }

    const upgraded = server.upgrade(req, {
      data: { req, clientId, sessionId, meta: meta ?? {} } satisfies SocketData,
    });
    if (!upgraded) {
      return Response.json(
        { message: "Websocket upgrade failed." },
        { status: 400 }
      );
    }
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

    const encoded = encodeBroadcast(proc, parsedInput);

    // Send message to all sockets.
    for (const connection of connections) {
      if (!connection.isConnected) {
        connection._offlineMessageQueue.push(encoded);
      } else {
        const result = connection._ws.sendBinary(encoded);
        if (result < 0) {
          // Result of -1 indicates a connection failure.
          connection._offlineMessageQueue.push(encoded);
        }
      }
    }
  }

  in(topic: string | Iterable<string>) {
    return new TopicScope(this, topic);
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

class TopicScope<ConnectionData> {
  #server: ChatterServer<ConnectionData>;
  #topics: string[];

  constructor(
    server: ChatterServer<ConnectionData>,
    topic: string | Iterable<string>
  ) {
    this.#server = server;

    if (typeof topic === "string") {
      this.#topics = [topic];
    } else {
      this.#topics = Array.from(topic);
    }
  }

  /**
   * Calls a procedure on all clients subscribed to `topic`.
   */
  async broadcast(proc: Proc<null, any>, input?: null): Promise<void>;
  async broadcast<I>(proc: Proc<I, any>, input: I): Promise<void>;

  /**
   * Calls a procedure on all clients subscribed to any topic in `topics`.
   */
  async broadcast(proc: Proc<null, any>, input?: null): Promise<void>;
  async broadcast<I>(proc: Proc<I, any>, input: I): Promise<void>;

  async broadcast<I>(proc: Proc<I, any>, input?: I): Promise<void> {
    return this.#server.broadcast(this.#topics, proc, input);
  }

  // todo: subscribe / unsubscribe (to make all sockets subscribed to a topic sub/unsub from other topics)
}

export interface ServerConnectionBroadcastOptions extends BroadcastOptions {
  includeSelf?: boolean;
}

enum ConnectionState {
  Disconnected,
  Connected,
}

/**
 * Represents one client from the server's perspective.
 */
export class ServerConnection<Data> implements Connection {
  _server: ChatterServer<Data>;
  _ws: Bun.ServerWebSocket<SocketData>;
  _topics = new Set<string>();
  _ackListeners = new Map<string, AckListener>();

  /**
   * Cache acks to send to the client while state is Disconnected.
   */
  _ackResponses = new AckResponseCache();

  /**
   * Cache messages to be sent while the connection is offline.
   */
  _offlineMessageQueue: Uint8Array[] = [];

  _ids = new AckIdGenerator();
  _sessionId: string;

  _destroyTimer: any;

  data: Data;
  state = ConnectionState.Connected;

  get isConnected() {
    return (
      this._ws.readyState === 1 && this.state === ConnectionState.Connected
    );
  }

  constructor(
    server: ChatterServer<Data>,
    ws: Bun.ServerWebSocket<SocketData>,
    data: Data
  ) {
    this._server = server;
    this._ws = ws;
    this._sessionId = ws.data.sessionId;
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
      this._ackListeners.set(ackId, listener);

      // Configure timeout
      timer = setTimeout(() => {
        listener.reject(
          new Error(`Procedure call timed out after ${waitTime}ms`)
        );
        this._ackListeners.delete(ackId);
      }, waitTime);

      // Send over _ws, await acknowledgement.
      const message = encodeProc(proc, ackId, parsedInput);
      if (!this.isConnected) {
        this._offlineMessageQueue.push(message);
      } else {
        const result = this._ws.sendBinary(message);
        if (result < 0) {
          // Result of -1 means there was a connection error. Queue for send on reconnect.
          this._offlineMessageQueue.push(message);
        }
      }
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

  /**
   * Called when the connection needs to be cleaned up and removed and can no longer reconnect.
   */
  _destroy() {
    for (const topic of this._topics) {
      this._server._topicMap.get(topic)?.delete(this);
    }
    this._topics.clear();
    this._ws.close();
    this._ackListeners.clear();
    this._offlineMessageQueue.length = 0;
  }

  /**
   * Called by the socket handler when the socket closes.
   */
  _disconnect() {
    this.state = ConnectionState.Disconnected;

    // Clean up this connection if not reconnected within 10 seconds.
    if (!this._destroyTimer) {
      this._destroyTimer = setTimeout(() => this._destroy(), 10000);
    }
  }

  /**
   * Called by the socket handler when a socket with the same sessionId is established.
   * Associates this connection with the new websocket object.
   */
  async _reconnect(ws: Bun.ServerWebSocket<SocketData>) {
    if (this._destroyTimer) {
      clearTimeout(this._destroyTimer);
      this._destroyTimer = undefined;
    }

    this.state = ConnectionState.Connected;
    this._ws = ws;

    // Send unsent acks (client will ignore them if they're not needed)
    for (const [ackId, message] of this._ackResponses.entries()) {
      ws.sendBinary(message);
    }

    // Sent unsent messages
    for (const message of this._offlineMessageQueue) {
      ws.sendBinary(message);
    }
    this._offlineMessageQueue.length = 0;
  }
}
