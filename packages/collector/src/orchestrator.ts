import { appendActivity, type Vault, type SourceConfig, type CollectorState, type LlmProvider } from "@openpulse/core";
import { SourceMcpClient } from "./mcp-client.js";
import { getTemplate } from "./templates/registry.js";
import { parseLookback } from "./templates/types.js";
import { autoDiscover } from "./auto-discover.js";
import { saveCollectorState } from "./scheduler.js";

export async function collectSource(
  source: SourceConfig,
  vault: Vault,
  provider: LlmProvider,
  model: string
): Promise<CollectorState> {
  const client = new SourceMcpClient(source);
  const now = new Date();
  const lookbackMs = parseLookback(source.lookback);
  const since = new Date(now.getTime() - lookbackMs);

  try {
    console.error(`[collector] Connecting to ${source.name}...`);
    await client.connect();

    let items;
    const template = source.template ? getTemplate(source.template) : undefined;
    if (template) {
      console.error(`[collector] Using template: ${template.name}`);
      items = await template.collect(client, since, now);
    } else {
      console.error(`[collector] Using LLM auto-discovery`);
      items = await autoDiscover(client, provider, model, since, now);
    }

    console.error(`[collector] Collected ${items.length} items from ${source.name}`);

    for (const item of items) {
      await appendActivity(vault, {
        timestamp: item.timestamp ?? now.toISOString(),
        log: item.log,
        theme: item.theme ?? "auto",
        source: source.name,
      });
    }

    const state: CollectorState = {
      sourceName: source.name,
      lastRunAt: now.toISOString(),
      lastStatus: "success",
      entriesCollected: items.length,
    };
    await saveCollectorState(vault, state);
    return state;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[collector] Error collecting from ${source.name}: ${message}`);
    const state: CollectorState = {
      sourceName: source.name,
      lastRunAt: now.toISOString(),
      lastStatus: "error",
      lastError: message,
      entriesCollected: 0,
    };
    await saveCollectorState(vault, state);
    return state;
  } finally {
    await client.disconnect();
  }
}
