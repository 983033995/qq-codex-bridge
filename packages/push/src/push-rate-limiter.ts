import { PushRequestError } from "./push-error.js";

export class PushRateLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now
  ) {}

  consume(): void {
    const cutoff = this.now() - 60_000;
    while (this.timestamps[0] !== undefined && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxPerMinute) {
      throw new PushRequestError(429, "rate_limited", "push rate limit exceeded");
    }
    this.timestamps.push(this.now());
  }
}
