import { describe, it, expect, vi } from "vitest";
import { createApiBaseResolver } from "../src/lib/tauri-bridge.js";

describe("createApiBaseResolver (Tauri get_server_info bootstrap)", () => {
  const fallback = { base: "http://localhost:3001/api", headers: { Authorization: "Bearer dev-token" } };

  it("returns the dev fallback verbatim in the browser (tauri: false), never calling invoke", async () => {
    const invokeFn = vi.fn().mockResolvedValue({ port: 9999, token: "unused" });
    const resolve = createApiBaseResolver(false, invokeFn, fallback);

    const result = await resolve();

    expect(result).toEqual(fallback);
    expect(invokeFn).not.toHaveBeenCalled();
  });

  it("builds a 127.0.0.1 base URL + bearer header from get_server_info under Tauri", async () => {
    const invokeFn = vi.fn().mockResolvedValue({ port: 54321, token: "abc123" });
    const resolve = createApiBaseResolver(true, invokeFn, fallback);

    const result = await resolve();

    expect(result.base).toBe("http://127.0.0.1:54321/api");
    expect(result.headers).toEqual({ Authorization: "Bearer abc123" });
  });

  it("omits the Authorization header when get_server_info returns an empty token", async () => {
    const invokeFn = vi.fn().mockResolvedValue({ port: 54321, token: "" });
    const resolve = createApiBaseResolver(true, invokeFn, fallback);

    const result = await resolve();

    expect(result.headers).toEqual({});
  });

  it("memoizes a successful lookup — invoke is called exactly once across repeated calls", async () => {
    const invokeFn = vi.fn().mockResolvedValue({ port: 1234, token: "t" });
    const resolve = createApiBaseResolver(true, invokeFn, fallback);

    await resolve();
    await resolve();
    await resolve();

    expect(invokeFn).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup — a subsequent call retries invoke", async () => {
    const invokeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("not ready yet"))
      .mockResolvedValueOnce({ port: 4321, token: "retry-token" });
    const resolve = createApiBaseResolver(true, invokeFn, fallback);

    await expect(resolve()).rejects.toThrow("not ready yet");

    const result = await resolve();
    expect(result.base).toBe("http://127.0.0.1:4321/api");
    expect(invokeFn).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent in-flight calls into a single invoke", async () => {
    let resolveInvoke: (v: { port: number; token: string }) => void;
    const invokeFn = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveInvoke = resolve;
      }),
    );
    const resolve = createApiBaseResolver(true, invokeFn, fallback);

    const p1 = resolve();
    const p2 = resolve();
    resolveInvoke!({ port: 1, token: "x" });

    await Promise.all([p1, p2]);
    expect(invokeFn).toHaveBeenCalledTimes(1);
  });
});
