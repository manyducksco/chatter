import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Debouncer } from "./debouncer";

describe("Debouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls function after interval", () => {
    const fn = vi.fn();
    const debouncer = new Debouncer(100, fn);

    debouncer.queue("a", "b");
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith("a", "b");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resets timer on subsequent queue calls", () => {
    const fn = vi.fn();
    const debouncer = new Debouncer(100, fn);

    debouncer.queue("first");
    vi.advanceTimersByTime(50);
    debouncer.queue("second");
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledWith("second");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents execution", () => {
    const fn = vi.fn();
    const debouncer = new Debouncer(100, fn);

    debouncer.queue("data");
    debouncer.cancel();

    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  it("flush executes immediately", () => {
    const fn = vi.fn();
    const debouncer = new Debouncer(100, fn);

    debouncer.queue("urgent");
    debouncer.flush();
    expect(fn).toHaveBeenCalledWith("urgent");
    expect(fn).toHaveBeenCalledTimes(1);

    // Timer should be cleared, no double call
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calling flush with no queued function does nothing", () => {
    const fn = vi.fn();
    const debouncer = new Debouncer(100, fn);

    expect(() => debouncer.flush()).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it("supports void return types", () => {
    const fn = vi.fn();
    const debouncer = new Debouncer(100, fn);

    debouncer.queue();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalled();
  });
});
