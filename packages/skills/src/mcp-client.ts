import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class SourceMcpClient {
  private client: Client;
  private config: McpServerConfig;
  private connected = false;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.client = new Client({ name: `openpulse-collector-${config.name}`, version: "1.0.0" });
  }

  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>,
    });
    await this.client.connect(transport);
    this.connected = true;
  }

  async connectWithTransport(transport: Transport): Promise<void> {
    await this.client.connect(transport);
    this.connected = true;
  }

  async listTools() {
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}) {
    return this.client.callTool({ name, arguments: args });
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  isConnected(): boolean { return this.connected; }
}
