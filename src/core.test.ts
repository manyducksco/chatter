import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Proc,
  AckIdGenerator,
  AckResponseCache,
  createProc,
  encodeProc,
  decodeProc,
  encodeAck,
  decodeAck,
  encodeBroadcast,
  decodeBroadcast,
  getMessageType,
  MessageType,
  PING_MESSAGE,
  PONG_MESSAGE,
  READY_MESSAGE,
  printMessage,
} from "./core";

describe("AckIdGenerator", () => {
  it("generates sequential base-36 ids starting from 1", () => {
    const gen = new AckIdGenerator();
    const id1 = gen.next();
    const id2 = gen.next();
    expect(id1).toBe("1");
    expect(id2).toBe("2");
  });

  it("produces base-36 strings", () => {
    const gen = new AckIdGenerator();
    for (let i = 0; i < 100; i++) {
      const id = gen.next();
      expect(id).toMatch(/^[0-9a-z]+$/);
    }
  });

  it("produces monotonically increasing ids", () => {
    const gen = new AckIdGenerator();
    let prev = 0;
    for (let i = 0; i < 1000; i++) {
      const id = parseInt(gen.next(), 36);
      expect(id).toBeGreaterThan(prev);
      prev = id;
    }
  });
});

describe("AckResponseCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves by ackId", () => {
    const cache = new AckResponseCache();
    const proc = new Proc({ name: "test", timeout: 1000 });
    const msg = new Uint8Array([1, 2, 3]);
    cache.set(proc, "abc", msg);
    expect(cache.get("abc")).toBe(msg);
  });

  it("auto-expires entries after proc timeout", () => {
    const cache = new AckResponseCache();
    const proc = new Proc({ name: "test", timeout: 1000 });
    const msg = new Uint8Array([1, 2, 3]);
    cache.set(proc, "abc", msg);

    expect(cache.get("abc")).toBe(msg);

    vi.advanceTimersByTime(999);
    expect(cache.get("abc")).toBe(msg);

    vi.advanceTimersByTime(2);
    expect(cache.get("abc")).toBeUndefined();
  });

  it("iterates entries via entries()", () => {
    const cache = new AckResponseCache();
    const proc = new Proc({ name: "test", timeout: 1000 });
    cache.set(proc, "a", new Uint8Array([1]));
    cache.set(proc, "b", new Uint8Array([2]));
    const result = Array.from(cache.entries());
    expect(result).toHaveLength(2);
    expect(result.map(([k]) => k).sort()).toEqual(["a", "b"]);
  });

  it("clear() removes all entries and prevents auto-expiry from firing", () => {
    const cache = new AckResponseCache();
    const proc = new Proc({ name: "test", timeout: 1000 });
    cache.set(proc, "a", new Uint8Array([1]));
    cache.set(proc, "b", new Uint8Array([2]));

    expect(Array.from(cache.entries())).toHaveLength(2);

    cache.clear();

    expect(Array.from(cache.entries())).toHaveLength(0);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();

    // Advancing past the timeout should not resurrect entries
    vi.advanceTimersByTime(2000);
    expect(Array.from(cache.entries())).toHaveLength(0);
  });
});

describe("Proc", () => {
  it("stores name and timeout with default", () => {
    const proc = new Proc({ name: "foo" });
    expect(proc.name).toBe("foo");
    expect(proc.timeout).toBe(30000);
  });

  it("stores custom timeout", () => {
    const proc = new Proc({ name: "foo", timeout: 5000 });
    expect(proc.timeout).toBe(5000);
  });

  it("parseInput returns null when no takes schema", async () => {
    const proc = new Proc<null, void>({ name: "no-input" });
    const result = await proc.parseInput(undefined);
    expect(result).toBeNull();
  });

  it("parseInput validates through schema when takes is set", async () => {
    const takes = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value: value as number }),
        types: { input: {} as number, output: {} as number },
      },
    };
    const proc = new Proc<number, void>({ name: "with-input", takes });
    const result = await proc.parseInput(42);
    expect(result).toBe(42);
  });

  it("parseInput rejects when schema validation fails", async () => {
    const takes = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: () => ({ issues: [{ message: "bad input" }] }),
      },
    };
    const proc = new Proc<any, void>({ name: "failing", takes });
    await expect(proc.parseInput(42)).rejects.toThrow("bad input");
  });

  it("parseOutput returns null when no returns schema", async () => {
    const proc = new Proc<null, void>({ name: "no-output" });
    const result = await proc.parseOutput(undefined);
    expect(result).toBeNull();
  });

  it("parseOutput validates through schema when returns is set", async () => {
    const returns = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value: value as string }),
        types: { input: {} as string, output: {} as string },
      },
    };
    const proc = new Proc<void, string>({ name: "with-output", returns });
    const result = await proc.parseOutput("hello");
    expect(result).toBe("hello");
  });
});

describe("createProc", () => {
  it("returns a Proc with inferred types", () => {
    const proc = createProc({ name: "greet", timeout: 5000 });
    expect(proc).toBeInstanceOf(Proc);
    expect(proc.name).toBe("greet");
    expect(proc.timeout).toBe(5000);
  });
});

describe("Message encoding/decoding round-trips", () => {
  const proc = new Proc<string, void>({ name: "echo", timeout: 1000 });

  it("encodes and decodes Broadcast messages", () => {
    const encoded = encodeBroadcast(proc, "hello");
    expect(getMessageType(encoded)).toBe(MessageType.Broadcast);

    const decoded = decodeBroadcast(encoded);
    expect(decoded.name).toBe("echo");
    expect(decoded.input).toBe("hello");
  });

  it("encodes and decodes Broadcast with undefined input", () => {
    const noInputProc = new Proc<null, void>({ name: "ping" });
    const encoded = encodeBroadcast(noInputProc, undefined);
    const decoded = decodeBroadcast(encoded);
    expect(decoded.name).toBe("ping");
    expect(decoded.input).toBeUndefined();
  });

  it("encodes and decodes Proc messages", () => {
    const encoded = encodeProc(proc, "ack-42", "world");
    expect(getMessageType(encoded)).toBe(MessageType.Proc);

    const decoded = decodeProc(encoded);
    expect(decoded.name).toBe("echo");
    expect(decoded.ackId).toBe("ack-42");
    expect(decoded.input).toBe("world");
  });

  it("encodes and decodes successful Ack messages", () => {
    const encoded = encodeAck("ack-1", true, { result: "ok" });
    expect(getMessageType(encoded)).toBe(MessageType.Ack);

    const decoded = decodeAck(encoded);
    expect(decoded.ackId).toBe("ack-1");
    expect(decoded.success).toBe(true);
    if (decoded.success) {
      expect(decoded.output).toEqual({ result: "ok" });
    }
  });

  it("encodes and decodes failed Ack messages with error string", () => {
    const encoded = encodeAck("ack-2", false, "something went wrong");
    const decoded = decodeAck(encoded);
    expect(decoded.ackId).toBe("ack-2");
    expect(decoded.success).toBe(false);
    if (!decoded.success) {
      expect(decoded.error).toBe("something went wrong");
    }
  });

  it("encodes failed Ack from Error instance, extracting message", () => {
    const encoded = encodeAck("ack-3", false, new Error("oops"));
    const decoded = decodeAck(encoded);
    expect(decoded.ackId).toBe("ack-3");
    expect(decoded.success).toBe(false);
    if (!decoded.success) {
      expect(decoded.error).toBe("oops");
    }
  });

  it("throws if encodeAck failure output is not a string or Error", () => {
    expect(() => encodeAck("ack-4", false, 42 as any)).toThrow(
      "Output should be an error message"
    );
  });

  it("encodes and decodes binary data in messages", () => {
    const bin = new Uint8Array([0, 1, 2, 255]);
    const binProc = new Proc<Uint8Array, void>({ name: "bin" });
    const encoded = encodeProc(binProc, "ack-bin", bin);
    const decoded = decodeProc(encoded);
    expect(decoded.input).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.input as Uint8Array)).toEqual([0, 1, 2, 255]);
  });
});

describe("Pre-encoded singletons", () => {
  it("PING_MESSAGE has correct type byte", () => {
    expect(getMessageType(PING_MESSAGE)).toBe(MessageType.Ping);
  });

  it("PONG_MESSAGE has correct type byte", () => {
    expect(getMessageType(PONG_MESSAGE)).toBe(MessageType.Pong);
  });

  it("READY_MESSAGE has correct type byte", () => {
    expect(getMessageType(READY_MESSAGE)).toBe(MessageType.Ready);
  });
});

describe("getMessageType", () => {
  it("peekUint8 on empty buffer returns undefined (lib0 behavior)", () => {
    const result = getMessageType(new Uint8Array(0));
    // lib0's peekUint8 returns undefined for an empty buffer rather than throwing
    expect([undefined, MessageType.Ready]).toContain(result);
  });
});

describe("printMessage", () => {
  it("calls callback with decoded data for Ready message", () => {
    const callback = vi.fn();
    printMessage(READY_MESSAGE, callback);
    expect(callback).toHaveBeenCalledWith({ type: "ready" });
  });

  it("calls callback with decoded data for Ping message", () => {
    const callback = vi.fn();
    printMessage(PING_MESSAGE, callback);
    expect(callback).toHaveBeenCalledWith({ type: "ping" });
  });

  it("calls callback with decoded data for Pong message", () => {
    const callback = vi.fn();
    printMessage(PONG_MESSAGE, callback);
    expect(callback).toHaveBeenCalledWith({ type: "pong" });
  });

  it("calls callback with decoded data for Proc message", () => {
    const callback = vi.fn();
    const proc = new Proc<string, void>({ name: "hello" });
    const msg = encodeProc(proc, "a1", "data");
    printMessage(msg, callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "proc",
        payload: expect.objectContaining({ name: "hello", ackId: "a1" }),
      })
    );
  });

  it("calls callback with decoded data for Ack message", () => {
    const callback = vi.fn();
    const msg = encodeAck("a1", true, "ok");
    printMessage(msg, callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ack",
        payload: expect.objectContaining({ ackId: "a1", success: true }),
      })
    );
  });

  it("calls callback with decoded data for Broadcast message", () => {
    const callback = vi.fn();
    const proc = new Proc<string, void>({ name: "bc" });
    const msg = encodeBroadcast(proc, "data");
    printMessage(msg, callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "broadcast",
        payload: expect.objectContaining({ name: "bc" }),
      })
    );
  });
});
