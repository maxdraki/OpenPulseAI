import { describe, it, expect, afterEach } from "vitest";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { mkdtemp, rm, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer, type ServerHandle } from "../server.js";
import { computeEntryId } from "@openpulse/dream/dist/ledger.js";

/** Grabs a free port from the OS, then releases it immediately — good enough
 *  for "start a server on some port and check its shape" tests where the
 *  exact number doesn't matter. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function makeTempVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openpulse-start-server-"));
}

describe("startServer", () => {
  let handles: ServerHandle[] = [];
  let tempDirs: string[] = [];
  let blocker: NetServer | undefined;

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
    for (const d of tempDirs) await rm(d, { recursive: true, force: true });
    tempDirs = [];
    if (blocker) {
      await new Promise<void>((resolve) => blocker!.close(() => resolve()));
      blocker = undefined;
    }
  });

  async function boot(opts: Parameters<typeof startServer>[0] = {}): Promise<ServerHandle> {
    const vaultRoot = opts.vaultRoot ?? (await makeTempVault());
    if (!opts.vaultRoot) tempDirs.push(vaultRoot);
    const handle = await startServer({ port: 0, ...opts, vaultRoot });
    handles.push(handle);
    return handle;
  }

  it("binds to the requested port and reports it on the returned handle", async () => {
    const handle = await boot();
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.server.listening).toBe(true);
  });

  it("respects an explicit vaultRoot option", async () => {
    const vaultRoot = await makeTempVault();
    tempDirs.push(vaultRoot);
    const handle = await boot({ vaultRoot });
    expect(handle.vaultRoot).toBe(vaultRoot);
    // ui-token gets written under the vault root we asked for.
    const token = (await readFile(join(vaultRoot, "ui-token"), "utf-8")).trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to the next port when the requested one is already in use", async () => {
    const reserved = await freePort();
    // Hold `reserved` open so startServer's first attempt hits EADDRINUSE.
    blocker = createNetServer();
    await new Promise<void>((resolve, reject) => {
      blocker!.listen(reserved, "127.0.0.1", () => resolve());
      blocker!.on("error", reject);
    });

    const handle = await boot({ port: reserved });
    expect(handle.port).not.toBe(reserved);
    expect(handle.port).toBeGreaterThan(reserved);
  });

  it("prints exactly one OPENPULSE_SERVER_READY line with the bound port", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
      orig(...args);
    };
    let handle: ServerHandle;
    try {
      handle = await boot();
    } finally {
      console.log = orig;
    }
    const readyLines = lines.filter((l) => l.startsWith("OPENPULSE_SERVER_READY"));
    expect(readyLines).toEqual([`OPENPULSE_SERVER_READY port=${handle!.port}`]);
  });

  it("writes a ui-server.json discovery file (mode 0600) and removes it on close", async () => {
    const handle = await boot();
    const discoveryPath = join(handle.vaultRoot, "ui-server.json");
    const raw = await readFile(discoveryPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.port).toBe(handle.port);
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.startedAt).toBe("string");

    const st = await stat(discoveryPath);
    expect(st.mode & 0o777).toBe(0o600);

    await handle.close();
    await expect(stat(discoveryPath)).rejects.toThrow();
  });

  it("serves /api/vault-health, rejecting unauthenticated requests and accepting the auto-generated token", async () => {
    const handle = await boot();
    const token = (await readFile(join(handle.vaultRoot, "ui-token"), "utf-8")).trim();
    const base = `http://127.0.0.1:${handle.port}`;

    const unauth = await fetch(`${base}/api/vault-health`);
    expect(unauth.status).toBe(401);

    const authed = await fetch(`${base}/api/vault-health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(authed.status).toBe(200);
  });

  it("reports per-entry `processed` and excludes processed entries from unprocessedHotCount", async () => {
    const vaultRoot = await makeTempVault();
    tempDirs.push(vaultRoot);
    const hotDir = join(vaultRoot, "vault", "hot");
    await mkdir(hotDir, { recursive: true });
    await writeFile(
      join(hotDir, "2026-07-09.md"),
      "## 2026-07-09T10:00:00.000Z\n**Theme:** auto\n**Source:** github-activity\n\n### owner/repo\n**Commits:**\n* abc123: did a thing\n<!-- openpulse:entry -->\n"
    );
    const handle = await boot({ vaultRoot });
    const token = (await readFile(join(vaultRoot, "ui-token"), "utf-8")).trim();
    const base = `http://127.0.0.1:${handle.port}`;
    const headers = { Authorization: `Bearer ${token}` };

    // Not in the ledger yet → unprocessed.
    let entries = await (await fetch(`${base}/api/hot-entries`, { headers })).json();
    expect(entries).toHaveLength(1);
    expect(entries[0].processed).toBe(false);
    let health = await (await fetch(`${base}/api/vault-health`, { headers })).json();
    expect(health.hotCount).toBe(1);
    expect(health.unprocessedHotCount).toBe(1);

    // Mark it processed with the SAME id the dream pipeline would write.
    const { timestamp, source, theme, log } = entries[0];
    const id = computeEntryId({ timestamp, source, theme, log });
    await writeFile(
      join(hotDir, ".processed.json"),
      JSON.stringify({ [id]: { processedAt: "2026-07-09T10:01:00.000Z", batchId: "b1" } })
    );

    // processed flips true; total unchanged; unprocessed drops to 0.
    entries = await (await fetch(`${base}/api/hot-entries`, { headers })).json();
    expect(entries[0].processed).toBe(true);
    health = await (await fetch(`${base}/api/vault-health`, { headers })).json();
    expect(health.hotCount).toBe(1);
    expect(health.unprocessedHotCount).toBe(0);
  });

  it("supports a tokenPath override that writes the token somewhere other than <vaultRoot>/ui-token", async () => {
    const vaultRoot = await makeTempVault();
    tempDirs.push(vaultRoot);
    const altTokenDir = await makeTempVault();
    tempDirs.push(altTokenDir);
    const altTokenPath = join(altTokenDir, "custom-token-name");

    await boot({ vaultRoot, tokenPath: altTokenPath });

    const altToken = (await readFile(altTokenPath, "utf-8")).trim();
    expect(altToken).toMatch(/^[0-9a-f]{64}$/);
    await expect(readFile(join(vaultRoot, "ui-token"), "utf-8")).rejects.toThrow();
  });

  it("close() stops the server, is idempotent, and unregisters its signal handlers", async () => {
    const before = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
    const handle = await boot();
    const during = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
    expect(during).toBe(before + 2);

    await handle.close();
    await handle.close(); // idempotent — must not throw or double-decrement

    const after = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
    expect(after).toBe(before);
    expect(handle.server.listening).toBe(false);

    // Remove from the afterEach cleanup list — already closed.
    handles = handles.filter((h) => h !== handle);
  });
});
