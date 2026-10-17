import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guardCaption, loadBrandKit } from "../brand.js";
import { env } from "../env.js";
import { JsonStore, shortId } from "../store.js";

export interface Comment {
  id: string;
  author: string;
  text: string;
  reply: string | null;
  repliedAt: string | null;
}

export interface Post {
  id: string;
  platform: string;
  caption: string;
  mediaUrl: string | null;
  status: "draft" | "scheduled" | "published" | "deleted";
  author: string;
  createdAt: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  metrics: { impressions: number; likes: number; comments: number; shares: number };
  comments: Comment[];
}

export const socialStore = new JsonStore<Post>("social");

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function pushToDiscord(post: Post): Promise<string | null> {
  if (!env.discordWebhookUrl) return null;
  try {
    const res = await fetch(env.discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "AInstein (sandbox publisher)",
        content: `**[${post.platform}] published by ${post.author}**\n${post.caption}${post.mediaUrl ? `\n${post.mediaUrl}` : ""}`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? "delivered" : `discord returned ${res.status}`;
  } catch (e) {
    return `discord error: ${(e as Error).message}`;
  }
}

/**
 * social-mcp — the only place content reaches an audience.
 * Everything here is a sandbox (a JSON feed plus an optional Discord test
 * channel). The brand guard is layer-2 enforcement on ARGUMENTS; ArmorIQ is
 * layer-1 enforcement on WHICH agent may call WHICH tool.
 */
export function buildSocialServer(): McpServer {
  const server = new McpServer({ name: "social", version: "0.1.0" });

  server.registerTool(
    "list_posts",
    {
      title: "List posts",
      description: "Lists posts in the workspace with status (draft, scheduled, published).",
      inputSchema: { status: z.enum(["draft", "scheduled", "published", "all"]).default("all") },
    },
    async ({ status }) => {
      const posts = socialStore.all().filter((p) => p.status !== "deleted" && (status === "all" || p.status === status));
      return text(posts.map(({ comments, ...p }) => ({ ...p, commentCount: comments.length })));
    },
  );

  server.registerTool(
    "draft_post",
    {
      title: "Draft post",
      description: "Creates a DRAFT post in the workspace. Does not publish anything. Caption must follow the brand kit (platform allowlist, banned words, length).",
      inputSchema: {
        platform: z.string().describe("Target platform: telegram | discord (the channels the studio actually publishes to)"),
        caption: z.string().min(1).describe("Post text"),
        media_url: z.string().optional().describe("Optional video/preview URL from video-mcp"),
        author: z.string().optional().describe("Agent name creating the draft"),
      },
    },
    async ({ platform, caption, media_url, author }) => {
      const guard = guardCaption(caption, platform);
      if (!guard.ok) return fail(`Brand guard rejected the draft:\n- ${guard.violations.join("\n- ")}`);
      const post = socialStore.insert({
        id: shortId("post"),
        platform: platform.toLowerCase(),
        caption,
        mediaUrl: media_url ?? null,
        status: "draft",
        author: author ?? "agent",
        createdAt: new Date().toISOString(),
        scheduledAt: null,
        publishedAt: null,
        metrics: { impressions: 0, likes: 0, comments: 0, shares: 0 },
        comments: [],
      });
      return text({ ok: true, postId: post.id, status: post.status });
    },
  );

  server.registerTool(
    "schedule_post",
    {
      title: "Schedule post",
      description: "Schedules an existing draft for a future time. The post stays unpublished until the scheduled time.",
      inputSchema: { post_id: z.string(), scheduled_at: z.string().describe("ISO-8601 timestamp in the future") },
    },
    async ({ post_id, scheduled_at }) => {
      const post = socialStore.get(post_id);
      if (!post || post.status === "deleted") return fail(`post ${post_id} not found`);
      const when = new Date(scheduled_at);
      if (Number.isNaN(when.getTime())) return fail("scheduled_at is not a valid ISO timestamp");
      if (when.getTime() < Date.now()) return fail("scheduled_at must be in the future");
      const guard = guardCaption(post.caption, post.platform);
      if (!guard.ok) return fail(`Brand guard rejected scheduling:\n- ${guard.violations.join("\n- ")}`);
      socialStore.update(post.id, { status: "scheduled", scheduledAt: when.toISOString() });
      return text({ ok: true, postId: post.id, status: "scheduled", scheduledAt: when.toISOString() });
    },
  );

  server.registerTool(
    "publish_post",
    {
      title: "Publish post",
      description: "Marks a post as PUBLISHED in the workspace and records the publish time. The actual delivery to the audience is done by the channel tools (tg_send_message / tg_send_video for Telegram, discord_send for Discord). Only approved platforms are accepted.",
      inputSchema: { post_id: z.string(), platform: z.string().optional().describe("Override platform (must be approved)") },
    },
    async ({ post_id, platform }) => {
      const post = socialStore.get(post_id);
      if (!post || post.status === "deleted") return fail(`post ${post_id} not found`);
      const target = (platform ?? post.platform).toLowerCase();
      const guard = guardCaption(post.caption, target);
      if (!guard.ok) return fail(`Brand guard rejected publishing:\n- ${guard.violations.join("\n- ")}`);
      const publishedAt = new Date().toISOString();
      const updated = socialStore.update(post.id, {
        platform: target,
        status: "published",
        publishedAt,
        metrics: { impressions: 1, likes: 0, comments: 0, shares: 0 },
      })!;
      const discord = await pushToDiscord(updated);
      return text({ ok: true, postId: post.id, platform: target, status: "published", publishedAt, discord });
    },
  );

  server.registerTool(
    "fetch_comments",
    {
      title: "Fetch comments",
      description: "Returns audience comments on a published post, including which ones have no reply yet.",
      inputSchema: { post_id: z.string() },
    },
    async ({ post_id }) => {
      const post = socialStore.get(post_id);
      if (!post || post.status === "deleted") return fail(`post ${post_id} not found`);
      return text(post.comments);
    },
  );

  server.registerTool(
    "reply_comment",
    {
      title: "Reply to comment",
      description: "Posts a public reply to an audience comment. Visible to everyone; follows the brand voice.",
      inputSchema: { post_id: z.string(), comment_id: z.string(), reply: z.string().min(1) },
    },
    async ({ post_id, comment_id, reply }) => {
      const post = socialStore.get(post_id);
      if (!post || post.status === "deleted") return fail(`post ${post_id} not found`);
      const guard = guardCaption(reply, post.platform);
      if (!guard.ok) return fail(`Brand guard rejected the reply:\n- ${guard.violations.join("\n- ")}`);
      const comments = post.comments.map((c) => (c.id === comment_id ? { ...c, reply, repliedAt: new Date().toISOString() } : c));
      if (!comments.some((c) => c.id === comment_id)) return fail(`comment ${comment_id} not found`);
      socialStore.update(post.id, { comments });
      return text({ ok: true, postId: post.id, commentId: comment_id });
    },
  );

  server.registerTool(
    "delete_post",
    {
      title: "Delete post",
      description: "Permanently deletes a post (draft, scheduled or published). Destructive and irreversible.",
      inputSchema: { post_id: z.string() },
    },
    async ({ post_id }) => {
      const post = socialStore.get(post_id);
      if (!post || post.status === "deleted") return fail(`post ${post_id} not found`);
      socialStore.update(post.id, { status: "deleted" });
      return text({ ok: true, postId: post.id, status: "deleted" });
    },
  );

  server.registerTool(
    "get_posting_rules",
    {
      title: "Get posting rules",
      description: "Returns the brand rules the social tools enforce on every write (platform allowlist, banned words, caption limit).",
      inputSchema: {},
    },
    async () => {
      const k = loadBrandKit();
      return text({ approvedPlatforms: k.approvedPlatforms, bannedWords: k.bannedWords, maxCaptionLength: k.maxCaptionLength, requiredHashtags: k.requiredHashtags, voice: k.voice });
    },
  );

  return server;
}
