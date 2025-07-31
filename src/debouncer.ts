export class Debouncer<T extends (...args: any[]) => void> {
  #interval;
  #fn;

  #id?: any;
  #queued?: () => void;

  constructor(interval: number, fn: T) {
    this.#interval = interval;
    this.#fn = fn;
  }

  /**
   * Queues the function to be called with `args` after `interval`.
   * Resets the interval and cancels the queued function if it hasn't been called yet.
   */
  queue(...args: Parameters<T>) {
    this.cancel();
    this.#queued = this.#fn.bind(null, ...args);
    this.#id = setTimeout(this.#queued, this.#interval);
  }

  /**
   * Cancels the queued function if it hasn't been called yet.
   */
  cancel() {
    clearTimeout(this.#id);
    this.#queued = undefined;
  }

  /**
   * Immediately calls the queued function (if any).
   */
  flush() {
    clearTimeout(this.#id);
    this.#queued?.();
    this.#queued = undefined;
  }
}
