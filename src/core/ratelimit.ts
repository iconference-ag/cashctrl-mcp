export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** AGB Ziffer 6: 300 Anfragen Burst, 30 pro Sekunde Auffuellung. Wir warten, statt 429 zu kassieren. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: Sleep = realSleep,
  ) {
    this.tokens = capacity;
    this.last = now();
  }
  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSecond);
    this.last = t;
  }
  available(): number { this.refill(); return Math.floor(this.tokens); }
  /** Serialisiert alle take()-Aufrufe — parallele Aufrufer ueberziehen den Bucket sonst ins Negative. */
  take(): Promise<void> {
    const run = this.queue.then(() => this.takeOne(), () => this.takeOne());
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
  private async takeOne(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const ms = Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
      await this.sleep(ms);
      this.refill();
    }
    this.tokens -= 1;
  }
}
