import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This is the "critical proof" required by task-18: actually boot the
// BUNDLED sidecar output (built by scripts/build-sidecar-ui.sh into
// dist/openpulse-ui-server.cjs at the repo root — SEA injection isn't
// expected to succeed in most dev/CI environments, so this targets the
// standalone-bundle fallback, which is what the .cjs artifact always is)
// against a temp vault on a free port, and assert:
//   1. the readiness line is printed,
//   2. /api/vault-health is reachable and 401s without a token,
//   3. SIGTERM produces a clean exit (code 0) within a few seconds.
//
// Guarded to only run when the bundle already exists — it's a build
// artifact, not source, so this test doesn't invoke esbuild itself (that's
// scripts/build-sidecar-ui.sh's job, run separately as part of the
// build:sea:ui / build:desktop flow). Run
// `bash scripts/build-sidecar-ui.sh` once before `vitest run` to exercise it.
const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "..", "..", "..");
const bundlePath = join(repoRoot, "dist", "openpulse-ui-server.cjs");
const seaPath = join(repoRoot, "dist", "openpulse-ui-server");
const bundleExists = existsSync(bundlePath) || existsSync(seaPath);

describe.skipIf(!bundleExists)("bundled sidecar smoke test", () => {
  it("boots, reports readiness, serves an authenticated route, and shuts down cleanly on SIGTERM", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "openpulse-sidecar-smoke-"));
    const [command, args] = existsSync(seaPath) ? [seaPath, []] : ["node", [bundlePath]];

    // Strip VITEST from the child's env — vitest sets it in *this* process,
    // and the sidecar's own boot guard (`if (!process.env.VITEST) { ... }`,
    // see server.ts) would otherwise inherit it and never call startServer().
    const { VITEST: _vitest, ...envWithoutVitest } = process.env;
    const child = spawn(command, args, {
      env: { ...envWithoutVitest, OPENPULSE_VAULT: vaultRoot, OPENPULSE_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      const port = await waitForReadyPort(() => stdout, 20_000);
      expect(stdout).toContain(`OPENPULSE_SERVER_READY port=${port}`);

      const res = await fetch(`http://127.0.0.1:${port}/api/vault-health`);
      expect(res.status).toBe(401);

      const exitCode = await terminateAndWaitForExit(child, 10_000);
      expect(exitCode).toBe(0);
    } catch (err) {
      // Surface captured output on failure — invaluable for diagnosing a
      // bundling regression (e.g. a bad esbuild external) from CI logs.
      console.error("[sidecar-bundle.test] stdout:\n" + stdout);
      console.error("[sidecar-bundle.test] stderr:\n" + stderr);
      throw err;
    } finally {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      await rm(vaultRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

function waitForReadyPort(getStdout: () => string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const m = getStdout().match(/OPENPULSE_SERVER_READY port=(\d+)/);
      if (m) {
        clearInterval(timer);
        resolve(Number(m[1]));
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for OPENPULSE_SERVER_READY line"));
      }
    }, 100);
  });
}

function terminateAndWaitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for clean exit after SIGTERM")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.kill("SIGTERM");
  });
}
