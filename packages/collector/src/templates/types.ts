import type { SourceMcpClient } from "../mcp-client.js";

export interface CollectedItem {
  log: string;
  theme?: string;
  timestamp?: string;
}

export interface CollectionTemplate {
  name: string;
  description: string;
  collect(client: SourceMcpClient, since: Date, until: Date): Promise<CollectedItem[]>;
}

export function parseLookback(lookback: string): number {
  const match = lookback.match(/^(\d+)(h|d|w)$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    case "w": return value * 7 * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}
