/**
 * Tiny in-memory TTL cache with in-flight de-duplication: concurrent callers
 * for the same key share one upstream request. Failures are not cached.
 */
export class TtlCache {
  private entries = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor(private readonly maxEntries = 5000) {}

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;

    const value = load();
    this.entries.set(key, { expires: now + ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    if (this.entries.size > this.maxEntries) this.evict(now);
    return value;
  }

  invalidate(prefix: string): void {
    for (const k of this.entries.keys()) if (k.startsWith(prefix)) this.entries.delete(k);
  }

  private evict(now: number): void {
    for (const [k, e] of this.entries) if (e.expires <= now) this.entries.delete(k);
    // Still too big: drop oldest insertions first.
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(k);
    }
  }
}

/** Run `fn` over `items` with at most `limit` in flight. Keeps order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
