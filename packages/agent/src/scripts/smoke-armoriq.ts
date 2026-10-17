/**
 * ArmorIQ diagnostics. Run after filling ARMORIQ_* in .env and registering the
 * four agents and three MCP servers on platform.armoriq.ai.
 *
 *   npm run smoke:armoriq
 *
 * Each step prints PASS / FAIL with the backend's response so you can see
 * exactly which part of the platform setup is missing. No LLM is involved;
 * the plans below are hand-written to mirror what the agents declare.
 */
import armoriq from "@armoriq/sdk";
import { DelegatedGovernor, SessionGovernor, clientFor, grantDelegation } from "../armoriq.js";
import { env } from "../env.js";
import { McpHub } from "../mcpHub.js";

const { IntentToken } = armoriq;

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const record = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}\n      ${detail.replace(/\n/g, "\n      ")}`);
};
const errText = (e: unknown) => {
  const err = e as { message?: string; response?: { status?: number; data?: unknown } };
  return `${err.message ?? String(e)}${err.response ? ` [HTTP ${err.response.status}] ${JSON.stringify(err.response.data).slice(0, 400)}` : ""}`;
};

console.log(`mode=${env.armoriq.mode} user=${env.armoriq.userEmail} agents=${JSON.stringify(env.armoriq.agents)}\n`);
if (!env.armoriq.apiKey) {
  console.error("ARMORIQ_API_KEY is empty. Fill .env first.");
  process.exit(1);
}

const hub = new McpHub();
try {
  await hub.connect();
  record("connect to MCP servers", true, hub.listTools().map((t) => t.name).join(", "));
} catch (e) {
  record("connect to MCP servers", false, errText(e));
  process.exit(1);
}

// 1. API key + org bootstrap
try {
  const boot = await clientFor("publisher").bootstrap();
  record("bootstrap (API key valid)", true, JSON.stringify(boot).slice(0, 300));
} catch (e) {
  record("bootstrap (API key valid)", false, errText(e));
}

// 2. Registered MCPs visible to this org
try {
  const mcps = await clientFor("publisher").listMcps();
  const names = mcps.map((m: { name?: string; mcp_name?: string }) => m.name ?? m.mcp_name ?? JSON.stringify(m));
  const want = ["research", "video", "social"];
  const missing = want.filter((w) => !names.includes(w));
  record("MCP servers registered on platform", missing.length === 0, `found: [${names.join(", ")}]${missing.length ? `  missing: [${missing.join(", ")}]` : ""}`);
} catch (e) {
  record("MCP servers registered on platform", false, errText(e));
}

// 3. Mint a token for the publisher
const publisher = new SessionGovernor("publisher", hub);
let tokenOk = false;
try {
  const t = await publisher.plan(["social__list_posts", "social__publish_post", "social__delete_post"], "smoke: publisher plan");
  tokenOk = !!t;
  record("mint intent token (publisher)", tokenOk, t ? `tokenId=${t.tokenId} planHash=${t.planHash.slice(0, 16)}… expires=${new Date(t.expiresAt * 1000).toISOString()}` : "no token");
} catch (e) {
  record("mint intent token (publisher)", false, errText(e));
}

if (tokenOk) {
  // 4. Expect ALLOW for a read tool
  try {
    const d = await publisher.check("social__list_posts", { status: "all" });
    record("policy check: publisher list_posts → expect ALLOW", d.action === "allow", `${d.action} (${d.source}) ${d.reason ?? ""} ${d.matchedPolicy ?? ""}`);
    if (d.action === "allow") {
      const out = await publisher.execute("social__list_posts", { status: "all" });
      await publisher.report("social__list_posts", { status: "all" }, out, 5);
      record("execute + audit report", out.ok, out.text.slice(0, 120));
    }
  } catch (e) {
    record("policy check: publisher list_posts", false, errText(e));
  }
  // 5. Expect BLOCK for a destructive tool
  try {
    const d = await publisher.check("social__delete_post", { post_id: "post_seed01" });
    record("policy check: publisher delete_post → expect BLOCK", d.action === "block", `${d.action} (${d.source}) ${d.reason ?? ""} ${d.matchedPolicy ?? ""}`);
  } catch (e) {
    record("policy check: publisher delete_post", false, errText(e));
  }
  // 6. Expect HOLD for publish
  try {
    const d = await publisher.check("social__publish_post", { post_id: "post_seed02" });
    record("policy check: publisher publish_post → expect HOLD", d.action === "hold", `${d.action} (${d.source}) ${d.reason ?? ""} delegationId=${d.delegationId ?? "-"}`);
    if (d.action === "hold" && d.delegationId) console.log(`      → approve or reject it on the ArmorIQ dashboard; this script does not wait.`);
  } catch (e) {
    record("policy check: publisher publish_post", false, errText(e));
  }
  // 7. Tool not in plan → intent mismatch, no network needed
  try {
    const d = await publisher.check("social__reply_comment", { post_id: "x", comment_id: "y", reply: "z" });
    record("undeclared tool → expect BLOCK (intent-plan)", d.action === "block" && d.source === "intent-plan", `${d.action} (${d.source}) ${d.reason ?? ""}`);
  } catch (e) {
    record("undeclared tool", false, errText(e));
  }
}
await publisher.close();

// 8. Creator must be denied publish by policy
try {
  const creator = new SessionGovernor("creator", hub);
  await creator.plan(["social__draft_post", "social__publish_post"], "smoke: creator plan");
  const d = await creator.check("social__publish_post", { post_id: "post_seed02" });
  record("policy check: creator publish_post → expect BLOCK", d.action === "block", `${d.action} (${d.source}) ${d.reason ?? ""} ${d.matchedPolicy ?? ""}`);
  await creator.close();
} catch (e) {
  record("policy check: creator publish_post", false, errText(e));
}

// 9. Delegation
try {
  const grant = await grantDelegation({
    from: "publisher",
    to: "editor",
    parentToolNames: ["video__edit_video", "video__preview_video", "video__render_final", "social__publish_post"],
    allowedToolNames: ["video__edit_video", "video__preview_video"],
    goal: "smoke: delegation",
    validitySeconds: 900,
  });
  const a = grant.authority;
  record("delegateSubtree() → child tokens", a.grants.length === 2, a.grants.map((g) => `${g.action}: subtree ${g.subtreePath} trust=${g.trustId} proofLen=${g.token.subtreeDelegation?.inclusionProof.length ?? 0} expired=${IntentToken.isExpired(g.token)}`).join("\n") + `\nexpires=${new Date(a.expiresAt * 1000).toISOString()} delegate=${a.delegateAgentId}`);
  const editor = new DelegatedGovernor("editor", grant.authority, hub);
  const ok = await editor.check("video__preview_video", { project_id: "p" });
  const bad = await editor.check("video__render_final", { project_id: "p" });
  record("delegated scope: preview_video → expect ALLOW", ok.action === "allow", `${ok.action} ${ok.reason ?? ""}`);
  record("delegated scope: render_final → expect BLOCK", bad.action === "block", `${bad.action} ${bad.reason ?? ""}`);
  await editor.close();
} catch (e) {
  record("delegate()", false, errText(e));
}

await hub.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
