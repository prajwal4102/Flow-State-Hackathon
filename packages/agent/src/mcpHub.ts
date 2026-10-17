import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { env } from "./env.js";

export interface HubTool {
  /** Fully qualified `<mcp>__<tool>` name. This exact convention is what the ArmorIQ SDK's default tool-name parser expects. */
  name: string;
  mcp: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolOutcome {
  ok: boolean;
  text: string;
}

export function splitToolName(name: string): { mcp: string; tool: string } {
  const idx = name.indexOf("__");
  if (idx === -1) throw new Error(`tool name '${name}' is not in <mcp>__<tool> form`);
  return { mcp: name.slice(0, idx), tool: name.slice(idx + 2) };
}

/**
 * The agent side of the MCP boundary. One client per MCP server; tools are
 * exposed to the LLM under `<mcp>__<tool>` names so plan steps and ArmorIQ
 * policies can be expressed per server.
 */
export class McpHub {
  private clients = new Map<string, Client>();
  private tools: HubTool[] = [];

  private urls: Record<string, string> = {};

  private async connectOne(mcp: string, attempts = 8): Promise<Client> {
    const old = this.clients.get(mcp);
    if (old) await old.close().catch(() => undefined);
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      const client = new Client({ name: `studio-agent-${mcp}`, version: "0.1.0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(this.urls[mcp])));
        this.clients.set(mcp, client);
        return client;
      } catch (e) {
        lastError = e;
        // The public Telegram/Discord servers take a few seconds to log in after the host starts.
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async connect(): Promise<void> {
    this.urls = { research: env.mcp.research, video: env.mcp.video, social: env.mcp.social };
    if (env.mcp.telegram) this.urls.telegram = env.mcp.telegram;
    if (env.mcp.discord) this.urls.discord = env.mcp.discord;
    this.tools = [];
    for (const mcp of Object.keys(this.urls)) {
      const client = await this.connectOne(mcp);
      const { tools } = await client.listTools();
      for (const t of tools) {
        this.tools.push({ name: `${mcp}__${t.name}`, mcp, tool: t.name, description: t.description ?? "", inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} } });
      }
    }
  }

  listTools(): HubTool[] {
    return [...this.tools];
  }

  has(name: string): boolean {
    return this.tools.some((t) => t.name === name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const { mcp, tool } = splitToolName(name);
    let client = this.clients.get(mcp);
    if (!client) return { ok: false, text: `unknown MCP server '${mcp}'` };
    const attempt = async () => {
      // Video generation and 1080p renders can run for many minutes; give those tools a 15-minute budget.
      const timeout = mcp === "video" ? 900_000 : 360_000;
      const res = (await client!.callTool({ name: tool, arguments: args }, undefined, { timeout })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      const text = (res.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`)).join("\n");
      return { ok: !res.isError, text };
    };
    try {
      return await attempt();
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // Session-based servers (the public Telegram MCP) forget sessions when restarted; reconnect once and retry.
      if (/session/i.test(msg) || /HTTP 4(00|04)/.test(msg)) {
        try {
          client = await this.connectOne(mcp);
          return await attempt();
        } catch (e2) {
          return { ok: false, text: `MCP call failed after reconnect: ${(e2 as Error).message}` };
        }
      }
      return { ok: false, text: `MCP call failed: ${msg}` };
    }
  }

  async close(): Promise<void> {
    for (const c of this.clients.values()) await c.close().catch(() => undefined);
    this.clients.clear();
  }
}
