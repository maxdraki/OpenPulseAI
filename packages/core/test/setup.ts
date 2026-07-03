/**
 * Global vitest setup for `packages/core`. Defaults the embeddings module
 * (see `src/search/embeddings.ts`) to its "unavailable" test double for
 * every test in this package, so no test ever triggers the real lazy
 * `import("@huggingface/transformers")` / model download / network call
 * just by calling `rebuildIndex`/`searchIndex` without thinking about it.
 *
 * Tests that specifically exercise embeddings call `setEmbedderForTests`
 * with a fake embedder themselves (typically in a `beforeEach`); this
 * file's `afterEach` resets back to the "unavailable" default afterward so
 * that override never leaks into other test files.
 */
import { afterEach } from "vitest";
import { setEmbedderForTests } from "../src/search/embeddings.js";

setEmbedderForTests(null);

afterEach(() => {
  setEmbedderForTests(null);
});
