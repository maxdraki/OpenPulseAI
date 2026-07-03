import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureVaultRepo } from "./vault-git.js";

export class Vault {
  readonly root: string;
  readonly hotDir: string;
  readonly ingestDir: string;
  readonly warmDir: string;
  readonly pendingDir: string;
  readonly coldDir: string;
  readonly sessionsDir: string;

  constructor(root: string) {
    this.root = root;
    this.hotDir = join(root, "vault", "hot");
    this.ingestDir = join(root, "vault", "hot", "ingest");
    this.warmDir = join(root, "vault", "warm");
    this.pendingDir = join(root, "vault", "warm", "_pending");
    this.coldDir = join(root, "vault", "cold");
    this.sessionsDir = join(root, "vault", "sessions");
  }

  async init(): Promise<void> {
    await mkdir(this.hotDir, { recursive: true });
    await mkdir(this.ingestDir, { recursive: true });
    await mkdir(this.warmDir, { recursive: true });
    await mkdir(this.pendingDir, { recursive: true });
    await mkdir(this.coldDir, { recursive: true });
    await mkdir(this.sessionsDir, { recursive: true });
    // Adopts (or leaves alone) a git repo rooted at vault/ so existing
    // vaults get history on next start. Never throws — see vault-git.ts.
    await ensureVaultRepo(this);
  }

  dailyLogPath(date: string): string {
    return join(this.hotDir, `${date}.md`);
  }

  themeFilePath(theme: string): string {
    return join(this.warmDir, `${theme}.md`);
  }
}
