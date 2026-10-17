import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, "..");
export const repoRoot = path.resolve(packageRoot, "..", "..");
export const publicDir = path.join(packageRoot, "public");

const dotEnvPath = path.join(repoRoot, ".env");
if (fs.existsSync(dotEnvPath)) {
  const before = { ...process.env };
  process.loadEnvFile(dotEnvPath);
  for (const key of Object.keys(process.env)) {
    if (before[key] !== undefined && process.env[key] !== before[key]) {
      process.env[key] = before[key];
    }
  }
}

export type RoleName = "planner" | "creator" | "publisher" | "editor";
export type ArmorMode = "sdk" | "proxy";

const mode = (process.env.ARMORIQ_MODE ?? "sdk").toLowerCase();
if (mode !== "sdk" && mode !== "proxy") throw new Error(`ARMORIQ_MODE must be sdk or proxy, got '${mode}'`);

export const env = {
  port: Number(process.env.AGENT_PORT ?? 4200),
  armoriq: {
    apiKey: process.env.ARMORIQ_API_KEY ?? "",
    userEmail: (process.env.ARMORIQ_USER_EMAIL ?? "owner@example.com").trim().toLowerCase(),
    /**
     * Identity under which approval requests are filed. ArmorIQ enforces four eyes:
     * the member who requested an approval cannot approve it. Set this to a second
     * org member (the "operator") so the owner in ARMORIQ_USER_EMAIL can approve.
     */
    requesterEmail: ((process.env.ARMORIQ_REQUESTER_EMAIL ?? "").trim() || process.env.ARMORIQ_USER_EMAIL || "owner@example.com").trim().toLowerCase(),
    mode: mode as ArmorMode,
    tokenValiditySeconds: Number(process.env.ARMORIQ_TOKEN_VALIDITY_SECONDS ?? 1800),
    holdTimeoutSeconds: Number(process.env.ARMORIQ_HOLD_TIMEOUT_SECONDS ?? 300),
    agents: {
      planner: process.env.ARMORIQ_AGENT_PLANNER ?? "studio-planner",
      creator: process.env.ARMORIQ_AGENT_CREATOR ?? "studio-creator",
      publisher: process.env.ARMORIQ_AGENT_PUBLISHER ?? "studio-publisher",
      editor: process.env.ARMORIQ_AGENT_EDITOR ?? "studio-editor",
    } satisfies Record<RoleName, string>,
  },
  llm: {
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  },
  mcp: {
    research: process.env.MCP_RESEARCH_URL ?? "http://localhost:4100/mcp/research",
    video: process.env.MCP_VIDEO_URL ?? "http://localhost:4100/mcp/video",
    social: process.env.MCP_SOCIAL_URL ?? "http://localhost:4100/mcp/social",
    /** Public third-party Telegram bot MCP, proxied by the MCP host. Empty disables it. */
    telegram: process.env.MCP_TELEGRAM_URL ?? (process.env.TELEGRAM_BOT_TOKEN ? "http://localhost:4100/mcp/telegram" : ""),
    /** Public third-party Discord MCP, proxied by the MCP host. Empty disables it. */
    discord: process.env.MCP_DISCORD_URL ?? (process.env.DISCORD_BOT_TOKEN ? "http://localhost:4100/mcp/discord" : ""),
    hostUrl: (process.env.MCP_PUBLIC_URL ?? "http://localhost:4100").replace(/\/$/, ""),
  },
  telegram: {
    chatId: (process.env.TELEGRAM_CHAT_ID ?? "").trim(),
  },
  discord: {
    channelId: (process.env.DISCORD_CHANNEL_ID ?? "").trim(),
  },
};

export function assertConfigured(): string[] {
  const missing: string[] = [];
  if (!env.armoriq.apiKey) missing.push("ARMORIQ_API_KEY");
  if (!env.llm.apiKey) missing.push("DEEPSEEK_API_KEY");
  return missing;
}
