import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, "..");
export const repoRoot = path.resolve(packageRoot, "..", "..");
export const dataDir = path.join(packageRoot, "data");
export const runtimeDir = path.join(dataDir, "runtime");

// Load <repo>/.env without overriding variables already set in the shell.
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

fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(path.join(runtimeDir, "voiceovers"), { recursive: true });

export const env = {
  port: Number(process.env.MCP_PORT ?? 4100),
  publicUrl: (process.env.MCP_PUBLIC_URL ?? `http://localhost:${process.env.MCP_PORT ?? 4100}`).replace(/\/$/, ""),
  remotionApiUrl: (process.env.REMOTION_API_URL ?? "http://localhost:3210").replace(/\/$/, ""),
  remotionWebUrl: (process.env.REMOTION_WEB_URL ?? "http://localhost:5173").replace(/\/$/, ""),
  videoGenTimeoutMs: Number(process.env.VIDEO_GEN_TIMEOUT_MS ?? 300000),
  // How long render_final waits for a 1080p render before telling the agent to poll instead.
  renderWaitMs: Number(process.env.RENDER_WAIT_MS ?? 720000),
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? "",
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
  elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2",
  // ffmpeg used to mix a voiceover into a rendered MP4. Defaults to the binary Remotion ships, then PATH.
  ffmpegPath:
    process.env.FFMPEG_PATH ??
    [path.join(repoRoot, "..", "Remotion-Agent", "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffmpeg.exe")].find((p) => fs.existsSync(p)) ??
    "ffmpeg",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? "",
  // Public Telegram bot MCP (@node2flow/telegram-bot-mcp), spawned by this host and proxied at /mcp/telegram
  telegramBotToken: (process.env.TELEGRAM_BOT_TOKEN ?? "").trim(),
  telegramMcpPort: Number(process.env.TELEGRAM_MCP_PORT ?? 4300),
  // Public Discord MCP (mcp-discord), spawned by this host and proxied at /mcp/discord
  discordBotToken: (process.env.DISCORD_BOT_TOKEN ?? "").trim(),
  discordMcpPort: Number(process.env.DISCORD_MCP_PORT ?? 4310),
};
