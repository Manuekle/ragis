/**
 * Token bucket en memoria por clave (usuario+tenant). Suficiente para una tarea;
 * con varias réplicas ECS se complementa con WAF rate rules y, si las métricas lo piden, Redis.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();

  take(key: string, perMinute: number, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: perMinute, updated: now };
    const refill = ((now - b.updated) / 60_000) * perMinute;
    b.tokens = Math.min(perMinute, b.tokens + refill);
    b.updated = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.gc(now);
    return true;
  }

  private gc(now: number) {
    for (const [k, b] of this.buckets) if (now - b.updated > 10 * 60_000) this.buckets.delete(k);
  }
}
