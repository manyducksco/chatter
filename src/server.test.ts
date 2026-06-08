import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "./server";
import { createProc, Proc, encodeProc, encodeAck, encodeBroadcast, decodeAck, decodeProc, getMessageType, MessageType, PING_MESSAGE, PONG_MESSAGE, READY_MESSAGE } from "./core";

/** A Standard Schema that passes values through with no transformation. */
function pass<I>(): any {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate: (value: unknown) => ({ value: value as I }),
      types: { input: {} as I, output: {} as I },
    },
  };
}

/** A proc whose takes and returns pass values through. */
const echoProc = createProc({
  name: "echo",
  timeout: 5000,
  takes: pass<string>(),
  returns: pass<string>(),
});

async function flushAsync() {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

// --- Mocks ---

let mockWsCounter = 0;

class MockServerWebSocket {
  data: {
    req: Request;
    clientId: string;
    sessionId: string;
    meta: Record<string, any>;
  };
  readyState = 1; // Bun.OPEN
  sent: Uint8Array[] = [];
  id: number;
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;

  constructor(data: any) {
    this.data = data;
    this.id = ++mockWsCounter;
  }

  sendBinary(data: Uint8Array) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
  }
}

class MockBunServer {
  upgrades: Array<{ req: Request; data: any }> = [];
  clientIp = "10.0.0.1";

  upgrade(req: Request, options: { data: any }) {
    this.upgrades.push({ req, data: options.data });
    return true;
  }

  requestIP(_req: Request): { address: string; port: number } | null {
    return { address: this.clientIp, port: 12345 };
  }
}

function createMockSocketData(overrides: Partial<{ clientId: string; sessionId: string; req: Request; meta: Record<string, any> }> = {}) {
  return {
    req: new Request("http://localhost"),
    clientId: "test-client-1",
    sessionId: "test-session-1",
    meta: {},
    ...overrides,
  };
}

function createMockSocket(overrides: Partial<{ clientId: string; sessionId: string }> = {}) {
  return new MockServerWebSocket(createMockSocketData(overrides));
}

describe("ChatterServer", () => {
  let bunServer: MockBunServer;

  beforeEach(() => {
    mockWsCounter = 0;
    bunServer = new MockBunServer();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createServer", () => {
    it("returns a ChatterServer instance", () => {
      const server = createServer();
      expect(server).toBeDefined();
      expect(server.websocket).toBeDefined();
    });
  });

  describe("on()", () => {
    it("registers a proc handler", () => {
      const server = createServer();
      const proc = createProc({ name: "greet" });
      const handler = vi.fn();
      server.on(proc, handler);
      expect((server as any)._procs.has("greet")).toBe(true);
    });
  });

  describe("upgrade()", () => {
    it("rejects request without cid param", async () => {
      const server = createServer();
      const req = new Request("http://localhost/ws");
      const result = await server.upgrade(req, bunServer as any);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
    });

    it("rejects request without sid param", async () => {
      const server = createServer();
      const req = new Request("http://localhost/ws?cid=abc");
      const result = await server.upgrade(req, bunServer as any);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
    });

    it("upgrades request with valid params", async () => {
      const server = createServer();
      const req = new Request("http://localhost/ws?cid=abc&sid=def");
      const result = await server.upgrade(req, bunServer as any);
      expect(result).toBeUndefined();
      expect(bunServer.upgrades).toHaveLength(1);
      expect(bunServer.upgrades[0].data.clientId).toBe("abc");
      expect(bunServer.upgrades[0].data.sessionId).toBe("def");
    });
  });

  describe("WebSocket lifecycle", () => {
    it("creates a new connection on socket open", async () => {
      const server = createServer();
      const ws = createMockSocket();

      await server.websocket.open(ws as any);

      const conns = (server as any)._connections;
      expect(conns.size).toBe(1);
      expect(conns.has("test-session-1")).toBe(true);
      expect(ws.sent).toHaveLength(1);
      expect(getMessageType(ws.sent[0])).toBe(MessageType.Ready);
    });

    it("calls getConnectionData and onOpen hooks", async () => {
      const getConnectionData = vi.fn().mockResolvedValue({ userId: 42 });
      const onOpen = vi.fn();
      const server = createServer({ getConnectionData, onOpen });
      const ws = createMockSocket();

      await server.websocket.open(ws as any);

      expect(getConnectionData).toHaveBeenCalledWith(ws);
      expect(onOpen).toHaveBeenCalled();
      const conn = (server as any)._connections.get("test-session-1");
      expect(conn.data).toEqual({ userId: 42 });
    });

    it("reconnects existing connection on new socket with same sessionId", async () => {
      const server = createServer();
      const ws1 = createMockSocket({ sessionId: "same" });
      await server.websocket.open(ws1 as any);

      const ws2 = createMockSocket({ sessionId: "same" });
      await server.websocket.open(ws2 as any);

      const conns = (server as any)._connections;
      expect(conns.size).toBe(1);
      const conn = conns.get("same");
      expect(conn._ws).toBe(ws2);

      // Ready message should be sent on the new socket
      expect(ws2.sent).toHaveLength(1);
      expect(getMessageType(ws2.sent[0])).toBe(MessageType.Ready);
    });

    it("handles Ping messages with Pong response", async () => {
      const server = createServer();
      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      ws.sent = [];
      await server.websocket.message(ws as any, PING_MESSAGE.buffer as any);

      expect(ws.sent).toHaveLength(1);
      expect(getMessageType(ws.sent[0])).toBe(MessageType.Pong);
    });

    it("disconnects and starts destroy timer on close", async () => {
      const server = createServer();
      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      const conn = (server as any)._connections.get("test-session-1");
      expect(conn.state).toBe(1); // Connected

      // Subscribe to a topic to verify cleanup
      conn.subscribe("room");
      expect((server as any)._topicMap.get("room")?.has(conn)).toBe(true);

      await server.websocket.close(ws as any, 1000, "bye");

      expect(conn.state).toBe(0); // Disconnected

      // After 10 seconds the connection resources are destroyed
      vi.advanceTimersByTime(10001);
      expect((server as any)._topicMap.get("room")?.has(conn)).toBeFalsy();
      expect(conn._topics.size).toBe(0);
      expect(conn._ackListeners.size).toBe(0);
    });

    it("calls onClose hook when socket closes", async () => {
      const onClose = vi.fn();
      const server = createServer({ onClose });
      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      await server.websocket.close(ws as any, 1001, "gone");

      expect(onClose).toHaveBeenCalledWith(
        expect.anything(),
        1001,
        "gone"
      );
    });
  });

  describe("Proc handling", () => {
    it("handles Proc message and sends ack response", async () => {
      const server = createServer();
      server.on(echoProc, (input: string) => `echo: ${input}`);

      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      const procMsg = encodeProc(echoProc, "ack-1", "hello");
      await server.websocket.message(ws as any, procMsg.buffer as any);

      await vi.waitFor(() => {
        const ackMsg = ws.sent.find(
          (m) => getMessageType(m) === MessageType.Ack
        );
        expect(ackMsg).toBeDefined();
        const decoded = decodeAck(ackMsg!);
        expect(decoded.success).toBe(true);
        if (decoded.success) {
          expect(decoded.output).toBe("echo: hello");
        }
      }, { timeout: 1000, interval: 5 });
    });

    it("sends error ack when handler throws", async () => {
      const server = createServer();
      const proc = createProc({ name: "fail" });
      server.on(proc, () => { throw new Error("nope"); });

      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      const procMsg = encodeProc(proc, "ack-2", "data");
      await server.websocket.message(ws as any, procMsg.buffer as any);

      await vi.waitFor(() => {
        const ackMsg = ws.sent.find(
          (m) => getMessageType(m) === MessageType.Ack
        );
        expect(ackMsg).toBeDefined();
        const decoded = decodeAck(ackMsg!);
        expect(decoded.success).toBe(false);
      }, { timeout: 1000, interval: 5 });
    });

    it("sends error ack when no handler registered", async () => {
      const server = createServer();
      const proc = createProc({ name: "missing" });

      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      const procMsg = encodeProc(proc, "ack-3", "data");
      await server.websocket.message(ws as any, procMsg.buffer as any);

      await vi.waitFor(() => {
        const ackMsg = ws.sent.find(
          (m) => getMessageType(m) === MessageType.Ack
        );
        expect(ackMsg).toBeDefined();
        const decoded = decodeAck(ackMsg!);
        expect(decoded.success).toBe(false);
      }, { timeout: 1000, interval: 5 });
    });
  });

  describe("maxMessageBytes", () => {
    const strProc = createProc({ name: "echo", takes: pass<string>(), returns: pass<string>() });

    it("closes the connection when message exceeds the limit", async () => {
      const server = createServer({ maxMessageBytes: 10 });
      server.on(strProc, (input: string) => `echo: ${input}`);

      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      // Create a proc message larger than 10 bytes
      const largeInput = "x".repeat(20);
      const largeMsg = encodeProc(strProc, "ack-1", largeInput);
      expect(largeMsg.byteLength).toBeGreaterThan(10);

      await server.websocket.message(ws as any, largeMsg.buffer as any);

      expect(ws.closed).toBe(true);
      expect(ws.closeCode).toBe(1009);
    });

    it("processes messages within the size limit", async () => {
      const server = createServer({ maxMessageBytes: 100 });

      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      // Ping is tiny and should pass through
      await server.websocket.message(ws as any, PING_MESSAGE.buffer as any);

      expect(ws.closed).toBe(false);
      // Should have received a pong
      expect(getMessageType(ws.sent[1])).toBe(MessageType.Pong);
    });

    it("allows unlimited messages when maxMessageBytes is not set", async () => {
      const server = createServer();

      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      const largeInput = "x".repeat(50000);
      const largeMsg = encodeProc(strProc, "ack-1", largeInput);
      await server.websocket.message(ws as any, largeMsg.buffer as any);

      expect(ws.closed).toBe(false);
    });
  });

  describe("rateLimit", () => {
    function connectWithUrl(server: any, url: string, headers?: Record<string, string>) {
      const req = new Request(url, { headers });
      return server.upgrade(req, bunServer as any);
    }

    it("rejects upgrades exceeding maxConnectionsPerMinute", async () => {
      const server = createServer({
        rateLimit: { maxConnectionsPerMinute: 2 },
      });

      // First two connections should succeed
      const r1 = await connectWithUrl(server, "http://localhost/ws?cid=a&sid=1");
      expect(r1).toBeUndefined();

      const r2 = await connectWithUrl(server, "http://localhost/ws?cid=b&sid=2");
      expect(r2).toBeUndefined();

      // Third connection from same IP should be rejected
      const r3 = await connectWithUrl(server, "http://localhost/ws?cid=c&sid=3");
      expect(r3).toBeInstanceOf(Response);
      expect((r3 as Response).status).toBe(429);
    });

    it("allows connections from different IPs independently", async () => {
      const server = createServer({
        rateLimit: { maxConnectionsPerMinute: 1 },
      });

      // Connection from default IP (10.0.0.1)
      const r1 = await connectWithUrl(server, "http://localhost/ws?cid=a&sid=1");
      expect(r1).toBeUndefined();

      // Second from same IP is blocked
      const r2 = await connectWithUrl(server, "http://localhost/ws?cid=b&sid=2");
      expect((r2 as Response).status).toBe(429);

      // Different IP should still be allowed
      bunServer.clientIp = "10.0.0.2";
      const r3 = await connectWithUrl(server, "http://localhost/ws?cid=c&sid=3");
      expect(r3).toBeUndefined();
    });

    it("resets the limit after the time window", async () => {
      vi.useFakeTimers();
      const server = createServer({
        rateLimit: { maxConnectionsPerMinute: 1 },
      });

      const r1 = await connectWithUrl(server, "http://localhost/ws?cid=a&sid=1");
      expect(r1).toBeUndefined();

      // Same IP blocked
      const r2 = await connectWithUrl(server, "http://localhost/ws?cid=b&sid=2");
      expect((r2 as Response).status).toBe(429);

      // Advance past the 60 second window
      vi.advanceTimersByTime(60_001);

      // Should be allowed again
      const r3 = await connectWithUrl(server, "http://localhost/ws?cid=c&sid=3");
      expect(r3).toBeUndefined();
      vi.useRealTimers();
    });

    it("does not rate limit when rateLimit option is not set", async () => {
      const server = createServer();

      for (let i = 0; i < 100; i++) {
        const result = await connectWithUrl(
          server,
          `http://localhost/ws?cid=${i}&sid=${i}`,
        );
        expect(result).toBeUndefined();
      }
    });

    describe("trustProxy", () => {
      it("uses X-Forwarded-For when trustProxy is true", async () => {
        const server = createServer({
          rateLimit: { maxConnectionsPerMinute: 1, trustProxy: true },
        });

        // First connection from IP in header
        const r1 = await connectWithUrl(
          server,
          "http://localhost/ws?cid=a&sid=1",
          { "x-forwarded-for": "203.0.113.1" },
        );
        expect(r1).toBeUndefined();

        // Second from same forwarded IP is blocked
        const r2 = await connectWithUrl(
          server,
          "http://localhost/ws?cid=b&sid=2",
          { "x-forwarded-for": "203.0.113.1" },
        );
        expect((r2 as Response).status).toBe(429);

        // Different forwarded IP is allowed
        const r3 = await connectWithUrl(
          server,
          "http://localhost/ws?cid=c&sid=3",
          { "x-forwarded-for": "203.0.113.2" },
        );
        expect(r3).toBeUndefined();
      });

      it("falls back to requestIP when trustProxy is true but no header is present", async () => {
        const server = createServer({
          rateLimit: { maxConnectionsPerMinute: 1, trustProxy: true },
        });

        // No X-Forwarded-For header — uses requestIP (10.0.0.1 from mock)
        const r1 = await connectWithUrl(server, "http://localhost/ws?cid=a&sid=1");
        expect(r1).toBeUndefined();

        // Second from same requestIP is blocked
        const r2 = await connectWithUrl(server, "http://localhost/ws?cid=b&sid=2");
        expect((r2 as Response).status).toBe(429);
      });

      it("ignores X-Forwarded-For when trustProxy is false", async () => {
        const server = createServer({
          rateLimit: { maxConnectionsPerMinute: 1 },
        });

        // Client sends a forged header but trustProxy is false
        const r1 = await connectWithUrl(
          server,
          "http://localhost/ws?cid=a&sid=1",
          { "x-forwarded-for": "10.0.0.99" },
        );
        expect(r1).toBeUndefined();

        // Uses requestIP (10.0.0.1) so second connection is blocked
        const r2 = await connectWithUrl(
          server,
          "http://localhost/ws?cid=b&sid=2",
          { "x-forwarded-for": "10.0.0.99" },
        );
        expect((r2 as Response).status).toBe(429);
      });
    });
  });

  describe("Ack handling", () => {
    it("resolves pending ack listener when ack received", async () => {
      const server = createServer();
      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      const conn = (server as any)._connections.get("test-session-1");

      const promise = conn.call(echoProc, "data");
      await flushAsync();

      await vi.waitFor(() => {
        const procMsg = ws.sent.find(
          (m) => getMessageType(m) === MessageType.Proc
        );
        expect(procMsg).toBeDefined();
      }, { timeout: 1000, interval: 5 });

      const procMsg = ws.sent.find(
        (m) => getMessageType(m) === MessageType.Proc
      )!;
      const decoded = decodeProc(procMsg);

      // Send ack back
      const ack = encodeAck(decoded.ackId, true, "result");
      await server.websocket.message(ws as any, ack.buffer as any);

      await expect(promise).resolves.toBe("result");
    });
  });

  describe("broadcast()", () => {
    it("sends to all subscribed connections", async () => {
      const server = createServer();
      const proc = createProc({ name: "notify" });

      const ws1 = createMockSocket({ sessionId: "s1" });
      const ws2 = createMockSocket({ sessionId: "s2" });
      await server.websocket.open(ws1 as any);
      await server.websocket.open(ws2 as any);

      const conn1 = (server as any)._connections.get("s1");
      const conn2 = (server as any)._connections.get("s2");
      conn1.subscribe("chat");
      conn2.subscribe("chat");

      await server.broadcast("chat", proc, "hello");

      expect(ws1.sent).toHaveLength(2); // READY + broadcast
      expect(ws2.sent).toHaveLength(2); // READY + broadcast

      const bcMsg1 = ws1.sent[1];
      expect(getMessageType(bcMsg1)).toBe(MessageType.Broadcast);
    });

    it("does not broadcast to excluded connections", async () => {
      const server = createServer();
      const proc = createProc({ name: "notify" });

      const ws1 = createMockSocket({ sessionId: "s1" });
      const ws2 = createMockSocket({ sessionId: "s2" });
      await server.websocket.open(ws1 as any);
      await server.websocket.open(ws2 as any);

      const conn1 = (server as any)._connections.get("s1");
      const conn2 = (server as any)._connections.get("s2");
      conn1.subscribe("chat");
      conn2.subscribe("chat");

      await server.broadcast("chat", proc, "hello", { exclude: [conn2] });

      expect(ws1.sent).toHaveLength(2); // READY + broadcast
      expect(ws2.sent).toHaveLength(1); // READY only
    });

    it("does nothing when no connections exist", async () => {
      const server = createServer();
      const proc = createProc({ name: "nobody" });
      await expect(
        server.broadcast("empty", proc, "data")
      ).resolves.toBeUndefined();
    });

    it("does nothing when topic has no subscribers", async () => {
      const server = createServer();
      const proc = createProc({ name: "nobody" });
      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      await expect(
        server.broadcast("unused", proc, "data")
      ).resolves.toBeUndefined();
      expect(ws.sent).toHaveLength(1); // READY only
    });
  });

  describe("in() / TopicScope", () => {
    it("returns a TopicScope that broadcasts to a topic", async () => {
      const server = createServer();
      const proc = createProc({ name: "notify" });

      const ws = createMockSocket({ sessionId: "s1" });
      await server.websocket.open(ws as any);
      const conn = (server as any)._connections.get("s1");
      conn.subscribe("updates");

      await server.in("updates").broadcast(proc, "data");

      const bcMsg = ws.sent[1];
      expect(getMessageType(bcMsg)).toBe(MessageType.Broadcast);
    });
  });

  describe("find() / filter()", () => {
    it("find returns first connection matching predicate", async () => {
      const server = createServer();
      const ws1 = createMockSocket({ sessionId: "s1" });
      const ws2 = createMockSocket({ sessionId: "s2" });
      await server.websocket.open(ws1 as any);
      await server.websocket.open(ws2 as any);

      const found = server.find(
        (c: any) => (c as any)._sessionId === "s2"
      );
      expect(found).toBeDefined();
      expect((found as any)._sessionId).toBe("s2");
    });

    it("find returns undefined when no match", () => {
      const server = createServer();
      const result = server.find(() => false);
      expect(result).toBeUndefined();
    });

    it("filter returns all matching connections", async () => {
      const server = createServer();
      await server.websocket.open(createMockSocket({ sessionId: "s1" }) as any);
      await server.websocket.open(createMockSocket({ sessionId: "s2" }) as any);
      await server.websocket.open(createMockSocket({ sessionId: "s3" }) as any);

      const result = server.filter(() => true);
      expect(result).toHaveLength(3);
    });
  });

  describe("ServerConnection", () => {
    it("subscribe adds connection to topic map", async () => {
      const server = createServer();
      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      const conn = (server as any)._connections.get("test-session-1");
      conn.subscribe("room1");

      expect(conn._topics.has("room1")).toBe(true);
      expect((server as any)._topicMap.get("room1")?.has(conn)).toBe(true);
    });

    it("unsubscribe removes connection from topic map", async () => {
      const server = createServer();
      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      const conn = (server as any)._connections.get("test-session-1");
      conn.subscribe("room1");
      conn.unsubscribe("room1");

      expect(conn._topics.has("room1")).toBe(false);
      expect((server as any)._topicMap.get("room1")?.has(conn)).toBeFalsy();
    });

    it("isSubscribed returns correct status", async () => {
      const server = createServer();
      const ws = createMockSocket();
      await server.websocket.open(ws as any);

      const conn = (server as any)._connections.get("test-session-1");
      expect(conn.isSubscribed("foo")).toBe(false);
      conn.subscribe("foo");
      expect(conn.isSubscribed("foo")).toBe(true);
    });

    it("broadcast on connection excludes self by default", async () => {
      const server = createServer();
      const proc = createProc({ name: "notify" });

      const ws1 = createMockSocket({ sessionId: "s1" });
      const ws2 = createMockSocket({ sessionId: "s2" });
      await server.websocket.open(ws1 as any);
      await server.websocket.open(ws2 as any);

      const conn1 = (server as any)._connections.get("s1");
      const conn2 = (server as any)._connections.get("s2");
      conn1.subscribe("chat");
      conn2.subscribe("chat");

      ws1.sent = [];
      ws2.sent = [];

      await conn1.broadcast("chat", proc, "data");

      // conn1 should not receive its own broadcast
      const bc1 = ws1.sent.filter(
        (m: Uint8Array) => getMessageType(m) === MessageType.Broadcast
      );
      expect(bc1).toHaveLength(0);

      // conn2 should receive it
      const bc2 = ws2.sent.filter(
        (m: Uint8Array) => getMessageType(m) === MessageType.Broadcast
      );
      expect(bc2).toHaveLength(1);
    });

    it("broadcast includes self when includeSelf is true", async () => {
      const server = createServer();
      const proc = createProc({ name: "selfie" });

      const ws = createMockSocket({ sessionId: "s1" });
      await server.websocket.open(ws as any);
      const conn = (server as any)._connections.get("s1");
      conn.subscribe("chat");
      ws.sent = [];

      await conn.broadcast("chat", proc, "data", { includeSelf: true });

      const bc = ws.sent.filter(
        (m: Uint8Array) => getMessageType(m) === MessageType.Broadcast
      );
      expect(bc).toHaveLength(1);
    });

    it("_reconnect replays cached acks and offline queue", async () => {
      const server = createServer();
      const proc = createProc({ name: "test", timeout: 5000 });

      const ws1 = createMockSocket({ sessionId: "s1" });
      await server.websocket.open(ws1 as any);
      const conn = (server as any)._connections.get("s1");

      // Simulate an ack being cached
      const ackMsg = encodeAck("cached-ack", true, "old-result");
      conn._ackResponses.set(proc, "cached-ack", ackMsg);

      // Simulate an offline message
      const offlineMsg = encodeProc(proc, "offline-proc", "data");
      conn._offlineMessageQueue.push(offlineMsg);

      // Reconnect with new socket
      const ws2 = createMockSocket({ sessionId: "s1" });
      await server.websocket.open(ws2 as any);

      // After reconnect, cached acks and offline messages should be replayed
      const replayedAck = ws2.sent.find(
        (m: Uint8Array) =>
          getMessageType(m) === MessageType.Ack
      );
      expect(replayedAck).toBeDefined();

      const replayedMsg = ws2.sent.find(
        (m: Uint8Array) =>
          getMessageType(m) === MessageType.Proc
      );
      expect(replayedMsg).toBeDefined();
    });

    it("_destroy removes connection from map and cleans up", async () => {
      const server = createServer();
      const ws = createMockSocket({ sessionId: "s1" });
      await server.websocket.open(ws as any);
      const conn = (server as any)._connections.get("s1");
      conn.subscribe("topic");

      conn._destroy();

      expect((server as any)._connections.has("s1")).toBe(false);
      expect((server as any)._topicMap.get("topic")?.has(conn)).toBeFalsy();
      expect(conn._topics.size).toBe(0);
      expect(conn._ackListeners.size).toBe(0);
      expect(Array.from(conn._ackResponses.entries())).toHaveLength(0);
    });

    it("disconnect then destroy timer removes connection from map", async () => {
      const server = createServer();
      const ws = createMockSocket({ sessionId: "s1" });
      await server.websocket.open(ws as any);
      expect((server as any)._connections.has("s1")).toBe(true);

      await server.websocket.close(ws as any, 1000, "bye");

      // Connection should still exist during grace period
      expect((server as any)._connections.has("s1")).toBe(true);

      // After 10 seconds it should be destroyed and removed
      vi.advanceTimersByTime(10001);
      expect((server as any)._connections.has("s1")).toBe(false);
    });
  });
});
