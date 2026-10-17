/**
 * Prints the live ArmorIQ decision for every role × tool pair in the demo.
 * Use it after changing policies to see exactly what the platform enforces.
 *   npm run probe:matrix -w @studio/agent
 */
import { SessionGovernor } from "../armoriq.js";
import type { RoleName } from "../env.js";
import { McpHub } from "../mcpHub.js";

const matrix: Record<RoleName, string[]> = {
  planner: ["research__fetch_url", "research__get_brand_kit", "social__draft_post", "social__publish_post", "social__delete_post", "video__create_video"],
  creator: ["research__get_brand_kit", "video__create_video", "video__render_final", "social__draft_post", "social__publish_post", "social__delete_post"],
  publisher: ["social__list_posts", "social__schedule_post", "social__publish_post", "social__reply_comment", "social__delete_post", "video__render_final", "video__create_video"],
  editor: ["video__edit_video", "video__render_final", "social__publish_post"],
};

const hub = new McpHub();
await hub.connect();
const silence = ["Invoking MCP", "Using Merkle", "Capturing plan", "Plan captured", "Requesting intent", "Intent token issued", "ArmorIQ SDK initialized", "API key validated"];
const origLog = console.log;
console.log = (...a: unknown[]) => {
  if (!silence.some((s) => String(a[0]).includes(s))) origLog(...a);
};

for (const [role, tools] of Object.entries(matrix) as Array<[RoleName, string[]]>) {
  const gov = new SessionGovernor(role, hub);
  await gov.plan(tools, `probe ${role}`);
  origLog(`\n${role}`);
  for (const t of tools) {
    const d = await gov.check(t, {});
    origLog(`  ${d.action.toUpperCase().padEnd(5)} ${t.padEnd(28)} ${d.reason ?? ""} ${d.matchedPolicy ? `[${d.matchedPolicy}]` : ""}`);
  }
  await gov.close();
}
await hub.close();
process.exit(0);
