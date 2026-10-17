import type { RoleName } from "./env.js";
import type { HubTool } from "./mcpHub.js";

export interface RoleSpec {
  name: RoleName;
  label: string;
  persona: string;
  /** Which `<mcp>__<tool>` names this role can SEE. Visibility is deliberately wider than permission: ArmorIQ, not the prompt, decides what may run. */
  canSee: (toolName: string) => boolean;
}

const startsWithAny = (name: string, prefixes: string[]) => prefixes.some((p) => name.startsWith(p));

export const ROLES: Record<RoleName, RoleSpec> = {
  planner: {
    name: "planner",
    label: "Planner",
    persona:
      "You are the Planner for AInstein's social presence. You research trends and audience reactions, read reference material, and write short creative briefs. You never publish, schedule or delete anything.",
    canSee: (n) => startsWithAny(n, ["research__", "social__list_posts", "social__get_posting_rules", "social__draft_post", "social__delete_post", "social__publish_post", "social__fetch_comments", "telegram__tg_send_message", "discord__discord_send"]),
  },
  creator: {
    name: "creator",
    label: "Creator",
    persona:
      "You are the Creator for AInstein. You turn briefs into motion-graphics videos with the video tools, write captions in the brand voice, and leave drafts for the Publisher. Keep videos short (3 scenes, under 30 seconds) and voiceover scripts under 400 characters.",
    canSee: (n) => startsWithAny(n, ["video__", "social__draft_post", "social__list_posts", "social__get_posting_rules", "social__publish_post", "social__schedule_post", "research__get_brand_kit", "telegram__tg_send_message", "discord__discord_send"]),
  },
  publisher: {
    name: "publisher",
    label: "Publisher",
    persona:
      "You are the Publisher for AInstein. You schedule and publish approved content on approved platforms, announce published posts in every connected channel (Telegram, Discord), and reply to audience comments in the brand voice. You act only on existing posts; you do not write new campaigns.",
    canSee: (n) =>
      startsWithAny(n, [
        "social__", "video__get_video_status", "video__preview_video", "video__list_projects", "research__get_analytics", "research__get_brand_kit",
        "telegram__tg_get_me", "telegram__tg_get_chat", "telegram__tg_send_message", "telegram__tg_send_photo", "telegram__tg_send_video", "telegram__tg_delete_message", "telegram__tg_edit_message_text",
        "discord__discord_send", "discord__discord_read_messages", "discord__discord_get_server_info", "discord__discord_delete_message", "discord__discord_add_reaction",
      ]),
  },
  editor: {
    name: "editor",
    label: "Freelance editor (delegated)",
    persona:
      "You are a freelance video editor temporarily working inside AInstein under delegated authority. Do exactly what the brief asks, step by step, using the video tools. If a tool call is refused or fails, note it and move on to the next step; never look for workarounds. End with a list of what succeeded and what was refused.",
    canSee: (n) => startsWithAny(n, ["video__", "social__list_posts", "social__publish_post", "social__draft_post"]),
  },
};

export function toolsForRole(role: RoleName, all: HubTool[]): HubTool[] {
  return all.filter((t) => ROLES[role].canSee(t.name));
}

export function catalogText(tools: HubTool[]): string {
  return tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
}
