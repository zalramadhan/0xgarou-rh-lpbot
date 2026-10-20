import { isRevertError } from './errors.js';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Serializes async work per key. Used so two rapid button presses cannot
 * broadcast two transactions for the same position.
 */
export class KeyedMutex {
  private readonly tail = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tail.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    // Keep the chain alive but never surface a rejection as unhandled.
    const guard = result.then(
      () => undefined,
      () => undefined,
    );
    this.tail.set(key, guard);
    try {
      return await result;
    } finally {
      if (this.tail.get(key) === guard) this.tail.delete(key);
    }
  }
}

/**
 * Runs the tasks with at most `limit` of them in flight.
 *
 * The order of the results matches the order of the tasks, and a rejected
 * task does not stop the others.
 */
export async function mapLimit<T, R>(
  tasks: readonly T[],
  limit: number,
  fn: (task: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= tasks.length) return;
      results[index] = await fn(tasks[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Retries a read that failed for transport reasons. Reverts are real answers and
 * are rethrown immediately; everything else (provider hiccups, rate limits,
 * timeouts, flaky public RPCs) gets another chance with jittered backoff.
 *
 * An aborted request is not retried either: that is what the RPC failover
 * throws once it has been through every endpoint, and walking them again
 * would only repeat the same failure.
 */
export async function retryRpc<T>(fn: () => Promise<T>, attempts = 5, baseDelayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const aborted = (err as { name?: string })?.name === 'AbortError';
      if (isRevertError(err) || aborted || i === attempts - 1) throw err;
      const backoff = baseDelayMs * 2 ** i;
      await sleep(backoff + Math.floor(Math.random() * 250));
    }
  }
  throw lastError;
}
