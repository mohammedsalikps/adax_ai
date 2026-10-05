/**
 * Fixed-window request limiter kept in memory (single API process). Limits
 * brute force against sign-in, activation codes and device tokens. It is a
 * safeguard for this single-machine MVP, not a distributed rate limiter: a
 * restart clears it, and several API processes would each count separately.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { audit } from '../audit/audit.ts'
import type { DbOrTx } from '../db/client.ts'
import { HttpError } from './errors.ts'

export interface LimitRule {
  /** Requests allowed per window and key. */
  max: number
  windowSeconds: number
}

export interface LimitResult {
  allowed: boolean
  /** Seconds until the window resets (for Retry-After). */
  retryAfter: number
  /** True only for the first refusal in a window (so a flood is audited once, not per request). */
  firstRefusal: boolean
}

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()
  private sweeps = 0

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, rule: LimitRule): LimitResult {
    const t = this.now()
    if (++this.sweeps % 500 === 0) this.sweep(t)
    let e = this.hits.get(key)
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + rule.windowSeconds * 1000 }
      this.hits.set(key, e)
    }
    e.count++
    const retryAfter = Math.max(1, Math.ceil((e.resetAt - t) / 1000))
    return { allowed: e.count <= rule.max, retryAfter, firstRefusal: e.count === rule.max + 1 }
  }

  /** Forgets `key`'s window, as if it had never been hit (for a counted action that did not happen after all). */
  reset(key: string): void {
    this.hits.delete(key)
  }

  private sweep(t: number) {
    for (const [k, e] of this.hits) if (e.resetAt <= t) this.hits.delete(k)
  }
}

/**
 * Counts one request against `key`; over the limit it answers 429 with
 * Retry-After and records the first refusal of the window in the audit log.
 */
export async function enforceLimit(db: DbOrTx, limiter: RateLimiter, req: FastifyRequest, reply: FastifyReply, scope: string, key: string, rule: LimitRule): Promise<void> {
  const r = limiter.hit(`${scope}:${key}`, rule)
  if (r.allowed) return
  void reply.header('retry-after', String(r.retryAfter))
  if (r.firstRefusal) await audit(db, req, { action: 'access.rate_limited', outcome: 'denied', details: { scope, limit: rule.max, windowSeconds: rule.windowSeconds } })
  throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${r.retryAfter} seconds.`)
}
