/**
 * Local, on-device embeddings for the search index's semantic signal (see
 * `search/search.ts` for the hybrid FTS+vector ranking that consumes
 * these). Uses `@huggingface/transformers` (transformers.js) with
 * `Xenova/all-MiniLM-L6-v2` (384-dim), a small model whose weights
 * transformers.js caches locally on first use.
 *
 * `@huggingface/transformers` pulls in native/heavy bits (onnxruntime) that
 * must never be required for this package to build, bundle into a SEA
 * binary, or run offline. So the import is ALWAYS a lazy `import()` inside
 * a try/catch, never a top-level import anywhere in this module or its
 * callers. If the import fails (SEA binary without the optional platform
 * bits, first-run download failing offline, anything else), embeddings are
 * simply "unavailable" for the rest of this process and every caller must
 * treat that as a signal to degrade to FTS-only — never as a fatal error.
 */
import { vaultLog } from "../logger.js";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

/** First load includes downloading the (~25MB) model to transformers.js's
 *  default cache. A generous but bounded timeout so a hung/offline download
 *  can never wedge a caller (e.g. a scheduled dream run) indefinitely. */
const FIRST_LOAD_TIMEOUT_MS = 120_000;

/** Minimal shape of the callable returned by transformers.js's
 *  `pipeline("feature-extraction", ...)` — typed narrowly here so this
 *  module doesn't need the full library surface. */
type FeatureExtractionPipeline = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

export type Embedder = (texts: string[]) => Promise<Float32Array[] | null>;

const warnedMessages = new Set<string>();
async function warnOnce(message: string, detail?: string): Promise<void> {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.warn(`[embeddings] ${message}${detail ? `: ${detail}` : ""}`);
  try {
    await vaultLog("warn", `[embeddings] ${message}`, detail);
  } catch {
    // vaultLog never throws, but belt-and-braces: logging must never itself
    // become a fatal error here.
  }
}

/** Test-only injection point: set a fake embedder (or `null` to simulate
 *  "unavailable") so tests never download the real model or touch the
 *  network. Pass `undefined` to restore the real (lazy dynamic-import)
 *  production path. Production code never calls this — the zero-config
 *  path is the default. */
let testEmbedder: Embedder | null | undefined;
export function setEmbedderForTests(embedder: Embedder | null | undefined): void {
  testEmbedder = embedder;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

let pipelinePromise: Promise<FeatureExtractionPipeline | null> | undefined;

async function loadPipeline(): Promise<FeatureExtractionPipeline | null> {
  try {
    // Lazy dynamic import — see module docstring. Never hoisted/static.
    const mod = await withTimeout(
      import("@huggingface/transformers"),
      FIRST_LOAD_TIMEOUT_MS,
      "loading @huggingface/transformers"
    );
    const pipe = await withTimeout(
      mod.pipeline("feature-extraction", EMBEDDING_MODEL),
      FIRST_LOAD_TIMEOUT_MS,
      `loading ${EMBEDDING_MODEL}`
    );
    return pipe as unknown as FeatureExtractionPipeline;
  } catch (e) {
    await warnOnce(
      "local embedding model unavailable — search degrades to FTS-only",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }
}

function getPipeline(): Promise<FeatureExtractionPipeline | null> {
  if (!pipelinePromise) pipelinePromise = loadPipeline();
  return pipelinePromise;
}

function unpackOutput(
  output: { data: Float32Array | number[]; dims: number[] },
  count: number
): Float32Array[] {
  const dim = output.dims[output.dims.length - 1] ?? EMBEDDING_DIM;
  const flat = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
  const result: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    result.push(flat.slice(i * dim, (i + 1) * dim));
  }
  return result;
}

/** Embeds a batch of texts with the local model. Returns `null` (never
 *  throws) whenever embeddings are unavailable in this process — missing
 *  optional native platform bits, an offline first-download, a SEA
 *  bundling gap, or any runtime failure calling the model. Callers must
 *  treat `null` as "degrade to FTS-only". Returns `[]` for an empty input
 *  without touching the pipeline. */
export async function embedTexts(texts: string[]): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];

  if (testEmbedder !== undefined) {
    if (testEmbedder === null) return null;
    try {
      return await testEmbedder(texts);
    } catch (e) {
      await warnOnce(
        "test embedder failed — degrading to FTS-only for this call",
        e instanceof Error ? e.message : String(e)
      );
      return null;
    }
  }

  // Belt-and-braces safety net: this monorepo's vitest workspace has
  // multiple projects whose configs can end up collecting the same test
  // files under different project names (see packages/*/vitest.config.ts),
  // so a test file that relies solely on `setEmbedderForTests` being wired
  // up by one project's setupFiles could still run under another project
  // that never called it. Rather than depend on that wiring being correct
  // everywhere, any process running under vitest is treated as
  // "embeddings unavailable" unless the real end-to-end smoke test
  // explicitly opts back in via OPENPULSE_EMBED_SMOKE=1 — real model
  // downloads/inference must never happen just because *a* test suite ran.
  if (process.env.VITEST && process.env.OPENPULSE_EMBED_SMOKE !== "1") {
    return null;
  }

  const pipe = await getPipeline();
  if (!pipe) return null;

  try {
    const output = await pipe(texts, { pooling: "mean", normalize: true });
    return unpackOutput(output, texts.length);
  } catch (e) {
    await warnOnce(
      "embedding call failed — degrading to FTS-only for this call",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }
}

/**
 * Whether the local embedding model is actually usable in this process right
 * now — never throws. Mirrors `embedTexts`'s own availability logic (test
 * override, the vitest safety net, then the real memoized pipeline load) so
 * the two never disagree about whether search is FTS-only. Backs the
 * `embeddings` flag `packages/ui/server.ts`'s `/api/search` route adds to its
 * response — SEA/packaged builds exclude `@huggingface/transformers` (see
 * this module's docstring and `scripts/build-sea.sh`), so this is
 * consistently `false` there and the UI surfaces a "search is keyword-only"
 * notice instead of silently degrading with no explanation.
 */
export async function isEmbeddingsAvailable(): Promise<boolean> {
  if (testEmbedder !== undefined) return testEmbedder !== null;
  if (process.env.VITEST && process.env.OPENPULSE_EMBED_SMOKE !== "1") return false;
  const pipe = await getPipeline();
  return pipe !== null;
}

/** Cosine similarity between two equal-length (or safely truncated to the
 *  shorter of the two) vectors. Pure and side-effect-free. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
