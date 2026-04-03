import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Vault, ChatSession } from "@openpulse/core";

export function createNewSession(): ChatSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    messages: [],
    themesConsulted: [],
    createdAt: now,
    lastActivity: now,
  };
}

export async function saveSession(vault: Vault, session: ChatSession): Promise<void> {
  session.lastActivity = new Date().toISOString();
  const path = join(vault.sessionsDir, `${session.id}.json`);
  await writeFile(path, JSON.stringify(session, null, 2), "utf-8");
}

export async function loadSession(vault: Vault, sessionId: string): Promise<ChatSession | null> {
  try {
    const path = join(vault.sessionsDir, `${sessionId}.json`);
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as ChatSession;
  } catch {
    return null;
  }
}
