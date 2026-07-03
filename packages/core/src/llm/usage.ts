/**
 * Per-provider-instance token usage accounting.
 *
 * Each adapter owns one `UsageAccumulator` and records call/retry/token
 * counts as it goes; the Dream pipeline reads `getUsageTotals()` after a run
 * to log per-run totals. Where a provider's API doesn't report usage, adapters
 * record zeros rather than estimating.
 */

export interface UsageTotals {
  calls: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export class UsageAccumulator {
  private totals: UsageTotals = { calls: 0, retries: 0, inputTokens: 0, outputTokens: 0 };

  /** Record a completed call and the tokens it reported (0 if unavailable). */
  recordCall(usage: TokenUsage): void {
    this.totals.calls += 1;
    this.totals.inputTokens += usage.inputTokens || 0;
    this.totals.outputTokens += usage.outputTokens || 0;
  }

  recordRetry(): void {
    this.totals.retries += 1;
  }

  getTotals(): UsageTotals {
    return { ...this.totals };
  }

  reset(): void {
    this.totals = { calls: 0, retries: 0, inputTokens: 0, outputTokens: 0 };
  }
}

export function emptyUsageTotals(): UsageTotals {
  return { calls: 0, retries: 0, inputTokens: 0, outputTokens: 0 };
}

/** Merge multiple UsageTotals (e.g. one per provider call site) into one. */
export function mergeUsageTotals(...totals: Array<UsageTotals | undefined>): UsageTotals {
  const out = emptyUsageTotals();
  for (const t of totals) {
    if (!t) continue;
    out.calls += t.calls;
    out.retries += t.retries;
    out.inputTokens += t.inputTokens;
    out.outputTokens += t.outputTokens;
  }
  return out;
}
