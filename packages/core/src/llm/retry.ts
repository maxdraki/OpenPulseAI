/**
 * Shared retry/backoff wrapper for LLM provider adapters.
 *
 * Every adapter (anthropic.ts, openai.ts, gemini.ts, ollama.ts) wraps its raw
 * SDK/fetch call in `withRetry()` instead of hand-rolling its own backoff
 * loop. Errors are normalized to `LlmError` so retryability is decided the
 * same way regardless of which SDK threw.
 */

export interface LlmErrorOptions {
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  cause?: unknown;
}

/** Normalized error shape used by `withRetry` to decide retryability. */
export class LlmError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: LlmErrorOptions = {}) {
    super(message);
    this.name = "LlmError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

function readRetryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown })?.headers;
  let raw: string | null | undefined;
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    raw = (headers as { get(name: string): string | null }).get("retry-after");
  } else if (headers && typeof headers === "object") {
    raw = (headers as Record<string, string>)["retry-after"];
  }
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * Best-effort classification of an arbitrary thrown error into an `LlmError`
 * with a `status`/`retryable` verdict. Handles the shapes exposed by the
 * Anthropic SDK, OpenAI SDK (also used for Ollama's OpenAI-compatible
 * endpoint), and generic fetch/network errors (Gemini's SDK wraps fetch).
 *
 * Retryable: HTTP 429, HTTP 5xx, and network/transport errors.
 * Not retryable: HTTP 4xx other than 429 (bad key/prompt — retrying wastes money).
 */
export function classifyError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  const anyErr = err as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
    code?: string;
    cause?: { code?: string };
    message?: string;
    name?: string;
  };

  const status = anyErr?.status ?? anyErr?.statusCode ?? anyErr?.response?.status;
  const code = anyErr?.code ?? anyErr?.cause?.code;
  const retryAfterMs = readRetryAfterMs(err);
  const message = anyErr?.message ?? String(err);

  let retryable = false;
  if (typeof status === "number") {
    retryable = status === 429 || status >= 500;
  } else if (code && NETWORK_ERROR_CODES.has(code)) {
    retryable = true;
  } else if (
    /ConnectionError|ConnectionTimeoutError/i.test(anyErr?.name ?? "") ||
    /network|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(message)
  ) {
    retryable = true;
  }

  return new LlmError(message, { status, retryable, retryAfterMs, cause: err });
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  factor?: number;
  capDelayMs?: number;
  /** Called before each retry attempt (1-indexed) with the classified error. */
  onRetry?: (attempt: number, error: LlmError) => void;
  /** Injectable sleep for tests — defaults to a real setTimeout-based delay. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  maxRetries: 4,
  baseDelayMs: 1000,
  factor: 2,
  capDelayMs: 30_000,
};

/**
 * Runs `fn`, retrying on retryable errors with exponential backoff + jitter.
 * Base 1s, factor 2, up to 4 retries (5 attempts total), capped at 30s per
 * wait. Honors a `retry-after` header when present. Non-retryable errors
 * (e.g. 401/403 bad key) throw immediately without retrying.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const factor = opts.factor ?? DEFAULTS.factor;
  const capDelayMs = opts.capDelayMs ?? DEFAULTS.capDelayMs;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const classified = classifyError(err);

      if (!classified.retryable) {
        throw classified;
      }
      if (attempt >= maxRetries) {
        throw new LlmError(
          `LLM call failed after ${maxRetries} retries: ${classified.message}`,
          { status: classified.status, retryable: true, cause: classified }
        );
      }

      attempt += 1;
      opts.onRetry?.(attempt, classified);

      const backoff = Math.min(capDelayMs, baseDelayMs * Math.pow(factor, attempt - 1));
      const jittered = backoff * (0.5 + Math.random() * 0.5);
      const delayMs = Math.min(capDelayMs, classified.retryAfterMs ?? jittered);
      await sleep(delayMs);
    }
  }
}
