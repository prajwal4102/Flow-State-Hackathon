/**
 * Exercises the three MCP servers without ArmorIQ or an LLM.
 * Run the MCP host first: npm run dev:mcp
 */
import { McpHub } from "../mcpHub.js";

const hub = new McpHub();
await hub.connect();
console.log("tools:", hub.listTools().map((t) => t.name).join(", "));

const show = async (name: string, args: Record<string, unknown>) => {
  const r = await hub.call(name, args);
  console.log(`\n▶ ${name} ${JSON.stringify(args)}\n  ok=${r.ok}\n  ${r.text.slice(0, 500).replace(/\n/g, "\n  ")}`);
  return r;
};

await show("research__get_brand_kit", {});
await show("social__get_posting_rules", {});
await show("social__list_posts", { status: "all" });
const draft = await show("social__draft_post", { platform: "telegram", caption: "Smoke test caption from the MCP smoke script. #AInstein", author: "smoke" });
const postId = /"postId": "([^"]+)"/.exec(draft.text)?.[1];
await show("social__draft_post", { platform: "tiktok", caption: "This should be rejected by the brand guard (platform)" });
await show("social__draft_post", { platform: "discord", caption: "Guaranteed revolutionary results" });
if (postId) {
  await show("social__schedule_post", { post_id: postId, scheduled_at: new Date(Date.now() + 86400000).toISOString() });
  await show("social__publish_post", { post_id: postId });
  await show("social__delete_post", { post_id: postId });
}
await show("research__get_analytics", {});
await show("research__fetch_url", { url: `${process.env.MCP_PUBLIC_URL ?? "http://localhost:4100"}/demo/competitor-article` });
await show("video__list_projects", {});
await show("video__get_video_status", { project_id: "does-not-exist" });

await hub.close();
console.log("\nMCP smoke finished.");
