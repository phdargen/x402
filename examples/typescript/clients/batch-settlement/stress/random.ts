/**
 * Draws an exponentially distributed inter-arrival time, which makes arrivals a Poisson process.
 *
 * @param ratePerSecond - Mean arrival rate.
 * @returns The wait until the next arrival, in milliseconds.
 */
export function exponentialIntervalMs(ratePerSecond: number): number {
  // 1 - random() is in (0, 1], so the logarithm is finite.
  return (-Math.log(1 - Math.random()) / ratePerSecond) * 1000;
}

/**
 * Samples channel indices with a Zipf-hot / uniform-cold mix.
 *
 * Hot traffic follows a Zipf distribution over channel ranks (rank 1 is index 0), so a few
 * channels accumulate large `chargeCount` deltas. Cold traffic is uniform, so many distinct
 * channels collect small unclaimed amounts.
 */
export class ChannelSampler {
  private readonly cumulative: number[];

  /**
   * Builds the Zipf CDF.
   *
   * @param channels - Number of channels.
   * @param hotShare - Probability that a draw is a hot (Zipf) draw, 0-1.
   * @param zipfS - Zipf exponent.
   */
  constructor(
    private readonly channels: number,
    private readonly hotShare: number,
    zipfS: number,
  ) {
    const weights = Array.from({ length: channels }, (_, rank) => 1 / Math.pow(rank + 1, zipfS));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let running = 0;
    this.cumulative = weights.map(weight => {
      running += weight / total;
      return running;
    });
  }

  /**
   * Draws one channel index.
   *
   * @returns A channel index in [0, channels).
   */
  next(): number {
    if (Math.random() >= this.hotShare) {
      return Math.floor(Math.random() * this.channels);
    }
    const target = Math.random();
    let low = 0;
    let high = this.cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.cumulative[mid] < target) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }
}

/**
 * Sleeps for the given time.
 *
 * @param ms - Milliseconds to wait.
 * @returns A promise that resolves after the wait.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
