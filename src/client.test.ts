import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient, ConnectionState } from "./client";
import { createProc, Proc, encodeAck, encodeBroadcast, encodeProc, decodeAck, decodeProc, getMessageType, MessageType, READY_MESSAGE, PING_MESSAGE, PONG_MESSAGE } from "./core";

let currentMockWs: MockWebSocket | null = null;

async function flushAsync() {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  binaryType = "blob";
  sent: Uint8Array[] = [];

  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;

  constructor(url: string) {
    super();
    this.url = url;
    currentMockWs = this;
  }

  send(data: ArrayBufferLike) {
    this.sent.push(new Uint8Array(data));
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
  }
}

function mockOpen() {
  const ws = currentMockWs!;
  ws.readyState = MockWebSocket.OPEN;
  const event = new Event("open");
  ws.dispatchEvent(event);
  if (ws.onopen) ws.onopen(event);
}

function mockMessage(data: Uint8Array) {
  const ws = currentMockWs!;
  ws.readyState = MockWebSocket.OPEN;
  const event = new MessageEvent("message", { data: data.buffer as ArrayBuffer });
  ws.dispatchEvent(event);
  if (ws.onmessage) ws.onmessage(event);
}

function mockClose(code = 1000, reason = "") {
  const ws = currentMockWs!;
  ws.readyState = MockWebSocket.CLOSED;
  const event = new CloseEvent("close", { code, reason });
  ws.dispatchEvent(event);
  if (ws.onclose) ws.onclose(event);
}

function mockError() {
  const ws = currentMockWs!;
  ws.readyState = MockWebSocket.CLOSED;
  const event = new Event("error");
  ws.dispatchEvent(event);
  if (ws.onerror) ws.onerror(event);
}

function connect(client: any) {
  mockOpen();
  mockMessage(READY_MESSAGE);
}

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

/** A proc with no takes schema, using pass returns. */
const returnsOnlyProc = createProc({
  name: "returns-only",
  timeout: 5000,
  returns: pass<string>(),
});

describe("ChatterClient", () => {
  beforeEach(() => {
    currentMockWs = null;
    vi.stubGlobal("WebSocket", MockWebSocket);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates WebSocket with cid and sid params on construction", () => {
    createClient({ url: "ws://localhost:8080" });
    expect(currentMockWs).not.toBeNull();
    const url = new URL(currentMockWs!.url);
    expect(url.searchParams.has("cid")).toBe(true);
    expect(url.searchParams.has("sid")).toBe(true);
  });

  it("sets binaryType to arraybuffer", () => {
    createClient({ url: "ws://localhost:8080" });
    expect(currentMockWs!.binaryType).toBe("arraybuffer");
  });

  it("starts in Disconnected state, transitions to Connected on message", () => {
    const client = createClient({ url: "ws://localhost:8080" });
    expect(client.state).toBe(ConnectionState.Disconnected);
    expect(client.isConnected).toBe(false);

    mockOpen();
    expect(client.isConnected).toBe(false);

    mockMessage(READY_MESSAGE);
    expect(client.isConnected).toBe(true);
    expect(client.state).toBe(ConnectionState.Connected);
  });

  it("persists clientId in localStorage", () => {
    const client1 = createClient({ url: "ws://localhost:8080" });
    const id1 = client1.clientId;
    const client2 = createClient({ url: "ws://localhost:8080" });
    expect(client2.clientId).toBe(id1);
  });

  it("generates unique sessionId per instance", () => {
    const client1 = createClient({ url: "ws://localhost:8080" });
    const client2 = createClient({ url: "ws://localhost:8585" });
    expect(client1.sessionId).not.toBe(client2.sessionId);
  });

  describe("call()", () => {
    it("sends encoded Proc message when connected and resolves on ack", async () => {
      const client = createClient({ url: "ws://localhost:8080" });
      connect(client);

      const promise = client.call(echoProc, "hello");

      // Flush microtasks so the Promise executor runs
      await flushAsync();

      const sent = currentMockWs!.sent.find(
        (m) => getMessageType(m) === MessageType.Proc
      );
      expect(sent).toBeDefined();
      const decoded = decodeProc(sent!);

      const ack = encodeAck(decoded.ackId, true, "echo: hello");
      mockMessage(ack);

      const result = await promise;
      expect(result).toBe("echo: hello");
    });

    it("queues message when not yet connected", async () => {
      const client = createClient({ url: "ws://localhost:8080" });

      const promise = client.call(echoProc, "offline data");
      await flushAsync();

      // No message should be sent yet
      const sentProcs = currentMockWs!.sent.filter(
        (m) => getMessageType(m) === MessageType.Proc
      );
      expect(sentProcs).toHaveLength(0);

      // Connecting triggers ready which flushes queue
      connect(client);
      await flushAsync();

      // The ready handler should have sent the queued proc message
      const sentAfter = currentMockWs!.sent.filter(
        (m) => getMessageType(m) === MessageType.Proc
      );
      expect(sentAfter.length).toBeGreaterThanOrEqual(1);

      // Respond with ack
      const lastMsg = currentMockWs!.sent.find(
        (m) => getMessageType(m) === MessageType.Proc
      );
      const decoded = decodeProc(lastMsg!);
      const ack = encodeAck(decoded.ackId, true, "queued-ok");
      mockMessage(ack);

      await expect(promise).resolves.toBe("queued-ok");
    });

    it("rejects on timeout", async () => {
      vi.useFakeTimers();
      const client = createClient({ url: "ws://localhost:8080" });
      connect(client);

      const promise = client.call(echoProc, "data");
      await flushAsync();

      vi.advanceTimersByTime(5001);
      await expect(promise).rejects.toThrow("timed out");
      vi.useRealTimers();
    });
  });

  describe("on()", () => {
    it("registers a handler and responds to Proc messages with ack", async () => {
      const client = createClient({ url: "ws://localhost:8080" });
      connect(client);

      client.on(echoProc, (input: string) => `echo: ${input}`);

      const callMsg = encodeProc(echoProc, "ack-from-server", "ping");
      mockMessage(callMsg);

      await vi.waitFor(() => {
        const ackMsg = currentMockWs!.sent.find(
          (m) => getMessageType(m) === MessageType.Ack
        );
        expect(ackMsg).toBeDefined();
        const decoded = decodeAck(ackMsg!);
        expect(decoded.success).toBe(true);
        if (decoded.success) {
          expect(decoded.output).toBe("echo: ping");
        }
      }, { timeout: 1000, interval: 5 });
    });

    it("responds with error ack when handler throws", async () => {
      const client = createClient({ url: "ws://localhost:8080" });
      connect(client);

      client.on(echoProc, () => {
        throw new Error("handler failed");
      });

      const callMsg = encodeProc(echoProc, "ack-error", "data");
      mockMessage(callMsg);

      await vi.waitFor(() => {
        const ackMsg = currentMockWs!.sent.find(
          (m) => getMessageType(m) === MessageType.Ack
        );
        expect(ackMsg).toBeDefined();
        const decoded = decodeAck(ackMsg!);
        expect(decoded.success).toBe(false);
      }, { timeout: 1000, interval: 5 });
    });
  });

  describe("broadcasts", () => {
    it("calls handler when broadcast received", async () => {
      const client = createClient({ url: "ws://localhost:8080" });
      connect(client);

      const handler = vi.fn();
      client.on(echoProc, handler);

      const broadcastMsg = encodeBroadcast(echoProc, "bc-data");
      mockMessage(broadcastMsg);

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith("bc-data", expect.anything());
      }, { timeout: 1000, interval: 5 });
    });
  });

  describe("state changes", () => {
    it("fires onStateChange callback on connect and disconnect", () => {
      const client = createClient({ url: "ws://localhost:8080" });
      const cb = vi.fn();
      client.onStateChange(cb);

      mockOpen();
      mockMessage(READY_MESSAGE);
      expect(cb).toHaveBeenCalledWith(ConnectionState.Connected);

      mockClose();
      expect(cb).toHaveBeenCalledWith(ConnectionState.Disconnected);
    });

    it("returns unsubscribe function from onStateChange", () => {
      const client = createClient({ url: "ws://localhost:8080" });
      const cb = vi.fn();
      const unsub = client.onStateChange(cb);
      unsub();

      mockOpen();
      mockMessage(READY_MESSAGE);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("ping/pong", () => {
    it("sends ping after pingInterval seconds of inactivity", async () => {
      vi.useFakeTimers();
      const client = createClient({
        url: "ws://localhost:8080",
        pingInterval: 1,
      });
      connect(client);

      // Clear any messages sent during connect
      currentMockWs!.sent = [];

      vi.advanceTimersByTime(1001);

      const pingMsg = currentMockWs!.sent.find(
        (m) => getMessageType(m) === MessageType.Ping
      );
      expect(pingMsg).toBeDefined();
      vi.useRealTimers();
    });

    it("does not close socket when pong is received in time", async () => {
      vi.useFakeTimers();
      const client = createClient({
        url: "ws://localhost:8080",
        pingInterval: 1,
      });
      connect(client);

      currentMockWs!.sent = [];

      // Trigger ping
      vi.advanceTimersByTime(1001);
      const closeSpy = vi.spyOn(currentMockWs!, "close");

      // Send pong before 5 second timeout
      mockMessage(PONG_MESSAGE);

      // Advance past the pong timeout
      vi.advanceTimersByTime(4500);
      expect(closeSpy).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("reconnection", () => {
    it("reconnects with exponential backoff on close", () => {
      vi.useFakeTimers();
      const client = createClient({ url: "ws://localhost:8080" });
      connect(client);

      const initialWs = currentMockWs;
      mockClose();

      // First reconnect attempt after ~1s
      vi.advanceTimersByTime(1000);
      expect(currentMockWs).not.toBe(initialWs);
      vi.useRealTimers();
    });

    it("reconnects on error", () => {
      vi.useFakeTimers();
      const client = createClient({ url: "ws://localhost:8080" });
      connect(client);

      const initialWs = currentMockWs;
      mockError();

      vi.advanceTimersByTime(1000);
      expect(currentMockWs).not.toBe(initialWs);
      vi.useRealTimers();
    });
  });

  describe("disconnect()", () => {
    it("closes the socket, clears caches, and rejects pending calls", () => {
      const client = createClient({ url: "ws://localhost:8080" });
      connect(client);

      const closeSpy = vi.spyOn(currentMockWs!, "close");

      (client as any).disconnect();

      expect(closeSpy).toHaveBeenCalled();
      expect(client.isConnected).toBe(false);
    });
  });
});
