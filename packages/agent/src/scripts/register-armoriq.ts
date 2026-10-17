/**
 * Registers the four agents and three MCP servers on the ArmorIQ control plane
 * using the Python SDK's `armoriq register` (POST /iap/sdk/register), which
 * accepts the org API key. The TypeScript CLI does not implement `register` yet.
 *
 *   npm run register:armoriq
 *
 * Requires: python 3 with `pip install armoriq-sdk`, and MCP_PUBLIC_URL set to a
 * URL the platform can reach (a cloudflared/ngrok tunnel or your deployment).
 *
 * The policy block written here is a BASELINE that applies org-wide per MCP
 * server (the control plane intersects the allow lists of every registration):
 * every productive tool allowed, destructive tools denied. Per-agent rules and
 * holds are authored in the platform's Policy Builder; see armoriq/SETUP.md.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env, repoRoot } from "../env.js";

const publicUrl = env.mcp.hostUrl;
if (/localhost|127\.0\.0\.1/.test(publicUrl)) {
  console.error(`MCP_PUBLIC_URL is ${publicUrl}. The platform cannot reach localhost; start a tunnel and set MCP_PUBLIC_URL first.`);
  process.exit(1);
}

const telegram = Boolean(env.mcp.telegram);
const discord = Boolean(env.mcp.discord);
const ALLOW = [
  "get_brand_kit", "fetch_trends", "fetch_url", "get_analytics",
  "list_posts", "get_posting_rules", "fetch_comments", "draft_post", "schedule_post", "publish_post", "reply_comment",
  "create_video", "edit_video", "preview_video", "get_video_status", "list_projects", "generate_voiceover", "render_final", "attach_voiceover",
  ...(telegram ? ["tg_get_me", "tg_get_chat", "tg_send_message", "tg_send_photo", "tg_send_video", "tg_send_document", "tg_send_audio"] : []),
  ...(discord ? ["discord_login", "discord_get_server_info", "discord_read_messages", "discord_send", "discord_add_reaction", "discord_add_multiple_reactions", "discord_get_forum_channels", "discord_get_forum_post"] : []),
];
const DENY = [
  "delete_post", "delete_project", "export_source",
  ...(telegram ? ["tg_delete_message", "tg_edit_message_text", "tg_edit_message_caption", "tg_set_webhook", "tg_delete_webhook", "tg_leave_chat"] : []),
  ...(discord
    ? ["discord_delete_message", "discord_delete_channel", "discord_delete_category", "discord_delete_forum_post", "discord_delete_webhook", "discord_create_webhook", "discord_edit_webhook", "discord_send_webhook_message", "discord_create_text_channel", "discord_create_category", "discord_edit_category", "discord_remove_reaction"]
    : []),
];
const discordServerYaml = discord
  ? `
  - id: discord
    url: ${publicUrl}/mcp/discord
    description: Public Discord MCP (mcp-discord) proxied by the AInstein host
    auth: { type: none }`
  : "";
const telegramServerYaml = telegram
  ? `
  - id: telegram
    url: ${publicUrl}/mcp/telegram
    description: Public Telegram bot MCP (@node2flow/telegram-bot-mcp) proxied by the AInstein host
    auth: { type: none }`
  : "";

const dir = path.join(repoRoot, "armoriq", "register");
fs.mkdirSync(dir, { recursive: true });

const yamlFor = (agentId: string) => `version: v1
identity:
  api_key: $ARMORIQ_API_KEY
  user_id: $ARMORIQ_USER_EMAIL
  agent_id: ${agentId}
environment: sandbox
proxy:
  url: https://proxy.armoriq.ai
  timeout: 30
  max_retries: 3
mcp_servers:
  - id: research
    url: ${publicUrl}/mcp/research
    description: AInstein research (brand kit, trends, URL fetch, analytics)
    auth: { type: none }
  - id: video
    url: ${publicUrl}/mcp/video
    description: AInstein video (Remotion create/edit/preview/render, ElevenLabs voiceover)
    auth: { type: none }
  - id: social
    url: ${publicUrl}/mcp/social
    description: AInstein social sandbox (draft, schedule, publish, reply, delete)
    auth: { type: none }${telegramServerYaml}${discordServerYaml}
policy:
  allow: [${ALLOW.join(", ")}]
  deny: [${DENY.join(", ")}]
intent:
  ttl_seconds: ${env.armoriq.tokenValiditySeconds}
  require_csrg: true
`;

let failed = 0;
for (const agentId of Object.values(env.armoriq.agents)) {
  const file = path.join(dir, `${agentId}.yaml`);
  fs.writeFileSync(file, yamlFor(agentId));
  const r = spawnSync("python", ["-m", "armoriq_sdk.cli", "register", "--config", file], {
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", ARMORIQ_API_KEY: env.armoriq.apiKey, ARMORIQ_USER_EMAIL: env.armoriq.userEmail },
  });
  const out = `${r.stdout}${r.stderr}`;
  const ok = r.status === 0 && /Agent .* registered/.test(out);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${agentId}\n      ${out.trim().split("\n").filter((l) => /registered|Policy applied|Error|failed/i.test(l)).join("\n      ") || out.trim().slice(-300)}`);
}
console.log(failed ? `\n${failed} registration(s) failed.` : `\nAll agents and MCP servers registered at ${publicUrl}. Now add per-agent rules and holds in the platform Policy Builder (armoriq/SETUP.md).`);
process.exit(failed ? 1 : 0);
