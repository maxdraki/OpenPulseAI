import { isSafeThemeName, readTheme, type Vault } from "@openpulse/core";
// Deep import — see search-index.ts for why this doesn't go through the
// @openpulse/core barrel.
import { searchIndex } from "@openpulse/core/dist/search/search.js";

export interface ReadThemeInput {
  theme: string;
}

const MAX_SUGGESTIONS = 3;

/**
 * Narrow-then-read entry point: fetches the full markdown of one warm theme
 * by name. Pair with search_index — search first to find the right theme
 * name, then read_theme for the complete page.
 */
export async function handleReadTheme(
  vault: Vault,
  input: ReadThemeInput
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!isSafeThemeName(input.theme)) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Invalid theme name: ${JSON.stringify(input.theme)}. Theme names may only contain letters, numbers, hyphens, and underscores.`,
        },
      ],
    };
  }

  const doc = await readTheme(vault, input.theme);
  if (doc) {
    return { content: [{ type: "text" as const, text: doc.content }] };
  }

  const suggestions = await searchIndex(vault, input.theme, { limit: MAX_SUGGESTIONS });
  const closeThemes = Array.from(new Set(suggestions.map((s) => s.theme)));

  const suggestionText =
    closeThemes.length > 0
      ? ` Did you mean: ${closeThemes.join(", ")}? Try search_index for a broader search.`
      : ` Try search_index to find the right theme name.`;

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `Theme not found: "${input.theme}".${suggestionText}`,
      },
    ],
  };
}
