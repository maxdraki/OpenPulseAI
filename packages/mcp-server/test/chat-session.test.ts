import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "@openpulse/core";
import { createNewSession, saveSession, loadSession } from "../src/tools/chat-session.js";

describe("Chat Session", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-session-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("creates a new session with UUID", () => {
    const session = createNewSession();
    expect(session.id).toBeTruthy();
    expect(session.messages).toEqual([]);
    expect(session.themesConsulted).toEqual([]);
  });

  it("saves and loads session round-trip", async () => {
    const session = createNewSession();
    session.messages.push({ role: "user", content: "Hello" });
    await saveSession(vault, session);
    const loaded = await loadSession(vault, session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);
    expect(loaded!.messages).toHaveLength(1);
  });

  it("returns null for non-existent session", async () => {
    const loaded = await loadSession(vault, "nonexistent-id");
    expect(loaded).toBeNull();
  });
});
