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
  /** Disposable SQLite FTS5 search index — never git-tracked (see
   *  `VAULT_GITIGNORE` in vault-git.ts) and safe to delete any time; it is
   *  rebuilt from the warm themes on demand (see `search/index-db.ts`). */
  readonly searchIndexPath: string;
  /** Holds approved Aigis rollup content (`<theme>.md`) and the append-only
   *  `submissions.jsonl` outcome log — deliberately NOT inside `warmDir`, so
   *  it's never picked up by the wiki/index/search machinery (see
   *  `.superpowers/sdd/task-17-brief.md`). Still inside `<root>/vault`, so
   *  the existing vault-git auto-commit (see `vault-git.ts`) covers it. */
  readonly aigisDir: string;

  constructor(root: string) {
    this.root = root;
    this.hotDir = join(root, "vault", "hot");
    this.ingestDir = join(root, "vault", "hot", "ingest");
    this.warmDir = join(root, "vault", "warm");
    this.pendingDir = join(root, "vault", "warm", "_pending");
    this.coldDir = join(root, "vault", "cold");
    this.sessionsDir = join(root, "vault", "sessions");
    this.searchIndexPath = join(root, "vault", ".search-index.sqlite");
    this.aigisDir = join(root, "vault", "aigis");
  }

  async init(): Promise<void> {
    await mkdir(this.hotDir, { recursive: true });
    await mkdir(this.ingestDir, { recursive: true });
    await mkdir(this.warmDir, { recursive: true });
    await mkdir(this.pendingDir, { recursive: true });
    await mkdir(this.coldDir, { recursive: true });
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.aigisDir, { recursive: true });
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
