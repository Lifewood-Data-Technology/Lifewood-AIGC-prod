/** Bounded FIFO slots shared by displayed covers and automatic upload posters. */
export class MediaSlots {
  private active = 0;
  private queue: { start: () => void }[] = [];
  constructor(readonly limit: number) {}
  get running() { return this.active; }
  get waiting() { return this.queue.length; }
  acquire(signal: AbortSignal, priority = false): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      let started = false, released = false;
      const waiter = { start: () => {
        started = true; this.active++;
        resolve(() => { if (released) return; released = true; this.active--; this.pump(); });
      } };
      signal.addEventListener("abort", () => {
        if (started) return;
        this.queue = this.queue.filter(item => item !== waiter);
        reject(signal.reason);
      }, { once: true });
      if (priority) this.queue.unshift(waiter); else this.queue.push(waiter);
      this.pump();
    });
  }
  private pump() { while (this.active < this.limit && this.queue.length) this.queue.shift()!.start(); }
}
export const frameGrabSlots = new MediaSlots(1);
