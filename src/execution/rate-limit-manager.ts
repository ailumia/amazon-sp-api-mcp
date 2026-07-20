import type { OperationDefinition } from "../types.js";

interface UsagePlan {
  rate: number;
  burst: number;
}

interface Bucket {
  rate?: number;
  capacity: number;
  tokens: number;
  updatedAt: number;
  blockedUntil: number;
  queue: Promise<void>;
}

export class RateLimitManager {
  readonly #buckets = new Map<string, Bucket>();

  public async acquire(key: string, operation: OperationDefinition): Promise<void> {
    const plan = usagePlan(operation);
    const bucket = this.bucket(key, plan);
    if (bucket.rate === undefined) return;
    const queued = bucket.queue.then(async () => this.take(bucket));
    bucket.queue = queued.catch(() => undefined);
    await queued;
  }

  public observe(key: string, operation: OperationDefinition, response: Response): void {
    const bucket = this.bucket(key, usagePlan(operation));
    const observedRate = positiveNumber(response.headers.get("x-amzn-ratelimit-limit"));
    if (observedRate !== undefined) {
      this.refill(bucket);
      bucket.rate = observedRate;
    }
    if (response.status === 429) {
      bucket.tokens = 0;
      bucket.blockedUntil = Math.max(bucket.blockedUntil, Date.now() + retryAfterMs(response));
    }
  }

  private bucket(key: string, plan: UsagePlan | undefined): Bucket {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        ...(plan === undefined ? {} : { rate: plan.rate }),
        capacity: plan?.burst ?? 1,
        tokens: plan?.burst ?? 1,
        updatedAt: Date.now(),
        blockedUntil: 0,
        queue: Promise.resolve(),
      };
      this.#buckets.set(key, bucket);
    }
    return bucket;
  }

  private async take(bucket: Bucket): Promise<void> {
    while (bucket.rate !== undefined) {
      this.refill(bucket);
      const now = Date.now();
      if (now < bucket.blockedUntil) {
        await delay(bucket.blockedUntil - now);
        continue;
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      await delay(Math.max(Math.ceil(((1 - bucket.tokens) / bucket.rate) * 1000), 1));
    }
  }

  private refill(bucket: Bucket): void {
    const now = Date.now();
    if (bucket.rate !== undefined) {
      bucket.tokens = Math.min(
        bucket.capacity,
        bucket.tokens + ((now - bucket.updatedAt) / 1000) * bucket.rate,
      );
    }
    bucket.updatedAt = now;
  }
}

function usagePlan(operation: OperationDefinition): UsagePlan | undefined {
  const match = operation.description?.match(/\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/u);
  const rate = positiveNumber(match?.[1] ?? null);
  const burst = positiveNumber(match?.[2] ?? null);
  return rate === undefined || burst === undefined ? undefined : { rate, burst };
}

function positiveNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get("retry-after");
  if (value === null) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 60_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 1_000 : Math.min(Math.max(date - Date.now(), 0), 60_000);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
