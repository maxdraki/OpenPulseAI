import { describe, it, expect, vi } from "vitest";
import { withRetry, classifyError, LlmError } from "../../src/llm/retry.js";

function immediateSleep() {
  return vi.fn().mockResolvedValue(undefined);
}

function httpError(status: number, message = "boom", headers?: Record<string, string>) {
  const err = new Error(message) as Error & { status: number; headers?: Record<string, string> };
  err.status = status;
  if (headers) err.headers = headers;
  return err;
}

function networkError(code: string) {
  const err = new Error(`network ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe("classifyError", () => {
  it("marks 429 as retryable", () => {
    expect(classifyError(httpError(429)).retryable).toBe(true);
  });

  it("marks 5xx as retryable", () => {
    expect(classifyError(httpError(503)).retryable).toBe(true);
    expect(classifyError(httpError(500)).retryable).toBe(true);
  });

  it("marks network/transport errors as retryable", () => {
    expect(classifyError(networkError("ECONNRESET")).retryable).toBe(true);
    expect(classifyError(networkError("ETIMEDOUT")).retryable).toBe(true);
  });

  it("does not mark 400/401/403 as retryable", () => {
    expect(classifyError(httpError(400)).retryable).toBe(false);
    expect(classifyError(httpError(401)).retryable).toBe(false);
    expect(classifyError(httpError(403)).retryable).toBe(false);
  });

  it("extracts retry-after header in ms", () => {
    const classified = classifyError(httpError(429, "rate limited", { "retry-after": "2" }));
    expect(classified.retryAfterMs).toBe(2000);
  });
});

describe("withRetry", () => {
  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 2) throw httpError(429);
      return "ok";
    });

    const result = await withRetry(fn, { sleep: immediateSleep() });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw httpError(503);
      return "ok";
    });

    const result = await withRetry(fn, { sleep: immediateSleep() });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on network errors then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 2) throw networkError("ECONNRESET");
      return "ok";
    });

    const result = await withRetry(fn, { sleep: immediateSleep() });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 401", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(401, "bad key"));

    await expect(withRetry(fn, { sleep: immediateSleep() })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 400", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(400, "bad prompt"));

    await expect(withRetry(fn, { sleep: immediateSleep() })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("bounds backoff delays passed to sleep at the cap", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(httpError(503));

    await expect(
      withRetry(fn, { sleep, maxRetries: 4, baseDelayMs: 1000, factor: 2, capDelayMs: 30_000 })
    ).rejects.toThrow();

    expect(sleep).toHaveBeenCalledTimes(4);
    for (const call of sleep.mock.calls) {
      expect(call[0]).toBeLessThanOrEqual(30_000);
      expect(call[0]).toBeGreaterThanOrEqual(0);
    }
  });

  it("propagates a clear error once max retries are exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(503, "still down"));

    await expect(
      withRetry(fn, { sleep: immediateSleep(), maxRetries: 2 })
    ).rejects.toThrow(/failed after 2 retries/i);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("calls onRetry for each retry attempt", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw httpError(429);
      return "ok";
    });
    const onRetry = vi.fn();

    await withRetry(fn, { sleep: immediateSleep(), onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toBe(1);
    expect(onRetry.mock.calls[1][0]).toBe(2);
  });

  it("throws an LlmError instance", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(401));
    try {
      await withRetry(fn, { sleep: immediateSleep() });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
    }
  });
});
