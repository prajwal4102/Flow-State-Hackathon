import crypto from "node:crypto";
import express from "express";
import { assertConfigured, env, publicDir } from "./env.js";
import { bus, type Envelope } from "./events.js";
import { McpHub } from "./mcpHub.js";
import { ROLES } from "./roles.js";
import { SCENARIOS, findScenario, type ScenarioParams } from "./scenarios.js";
import { beginRun, cancelRun, deliverReply, endConversation, endRun, isAwaitingReply } from "./runControl.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

const hub = new McpHub();
let hubReady = false;
async function ensureHub() {
  if (hubReady) return;
  await hub.connect();
  hubReady = true;
  console.log(`connected to MCP servers; ${hub.listTools().length} tools: ${hub.listTools().map((t) => t.name).join(", ")}`);
}

const runs = new Map<string, { scenario: string; status: "running" | "ok" | "error"; startedAt: string; summary?: string }>();
let active: string | null = null;

app.get("/api/config", async (_req, res) => {
  res.json({
    missing: assertConfigured(),
    mode: env.armoriq.mode,
    userEmail: env.armoriq.userEmail,
    agents: env.armoriq.agents,
    model: env.llm.model,
    mcpHost: env.mcp.hostUrl,
    roles: Object.values(ROLES).map((r) => ({ name: r.name, label: r.label })),
    scenarios: SCENARIOS.map(({ id, title, beat, description }) => ({ id, title, beat, description })),
    tools: hubReady ? hub.listTools().map((t) => t.name) : [],
    platformUrl: "https://platform.armoriq.ai",
    consoleUrl: "https://tools.armoriq.ai",
  });
});

app.get("/api/feed", async (_req, res) => {
  try {
    const r = await fetch(`${env.mcp.hostUrl}/feed`);
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ error: `MCP host unreachable: ${(e as Error).message}` });
  }
});

app.get("/api/library", async (_req, res) => {
  try {
    const r = await fetch(`${env.mcp.hostUrl}/library`);
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ error: `MCP host unreachable: ${(e as Error).message}` });
  }
});

app.post("/api/reset", async (_req, res) => {
  try {
    await fetch(`${env.mcp.hostUrl}/admin/reset`, { method: "POST" });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

app.get("/api/runs", (_req, res) => res.json([...runs.entries()].map(([id, r]) => ({ id, ...r }))));

/**
 * Live policy readiness: mints real tokens and asks ArmorIQ what it would decide
 * for the calls each demo beat depends on. Green means the platform policies
 * are configured the way the demo expects.
 */
app.get("/api/readiness", async (_req, res) => {
  if (assertConfigured().length) return res.status(400).json({ error: "missing env" });
  try {
    await ensureHub();
    const { SessionGovernor } = await import("./armoriq.js");
    const expectations: Array<{ role: "planner" | "creator" | "publisher"; tool: string; expect: "allow" | "hold" | "block"; beat: string }> = [
      { role: "creator", tool: "video__create_video", expect: "allow", beat: "Run a campaign" },
      { role: "publisher", tool: "social__schedule_post", expect: "allow", beat: "Run a campaign" },
      { role: "publisher", tool: "social__publish_post", expect: "hold", beat: "Publish now" },
      { role: "creator", tool: "social__publish_post", expect: "block", beat: "Creator tries to publish" },
      { role: "planner", tool: "social__delete_post", expect: "block", beat: "Poisoned article" },
      ...(env.mcp.telegram
        ? ([
            { role: "publisher", tool: "telegram__tg_send_message", expect: "hold", beat: "Publish now (Telegram)" },
            { role: "creator", tool: "telegram__tg_send_message", expect: "block", beat: "Creator tries to publish (Telegram)" },
            { role: "publisher", tool: "telegram__tg_delete_message", expect: "block", beat: "No deletes anywhere" },
          ] as const)
        : []),
      ...(env.mcp.discord
        ? ([
            { role: "publisher", tool: "discord__discord_send", expect: "hold", beat: "Publish now (Discord)" },
            { role: "creator", tool: "discord__discord_send", expect: "block", beat: "Creator tries to publish (Discord)" },
            { role: "publisher", tool: "discord__discord_delete_message", expect: "block", beat: "No deletes anywhere (Discord)" },
          ] as const)
        : []),
    ];
    const byRole = new Map<string, string[]>();
    for (const e of expectations) byRole.set(e.role, [...(byRole.get(e.role) ?? []), e.tool]);
    const results: Array<(typeof expectations)[number] & { actual: string; ok: boolean; reason?: string; matchedPolicy?: string }> = [];
    for (const [role, tools] of byRole) {
      const gov = new SessionGovernor(role as "planner" | "creator" | "publisher", hub);
      await gov.plan([...new Set(tools)], `readiness ${role}`);
      for (const e of expectations.filter((x) => x.role === role)) {
        const d = await gov.check(e.tool, {}, { dryRun: true });
        results.push({ ...e, actual: d.action, ok: d.action === e.expect, reason: d.reason, matchedPolicy: d.matchedPolicy });
      }
      await gov.close();
    }
    res.json({ ready: results.every((r) => r.ok), results });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/run", async (req, res) => {
  const { scenario, params } = req.body as { scenario: string; params?: ScenarioParams };
  const spec = findScenario(scenario);
  if (!spec) return res.status(400).json({ error: `unknown scenario '${scenario}'` });
  const missing = assertConfigured();
  if (missing.length) return res.status(400).json({ error: `missing env: ${missing.join(", ")}` });
  if (active && isAwaitingReply(active)) {
    // A finished run that is only waiting for a reply: close it so the new run can start.
    endConversation();
    for (let i = 0; i < 50 && active; i++) await new Promise((r) => setTimeout(r, 100));
  }
  if (active) return res.status(409).json({ error: `run ${active} is still in progress` });

  const runId = crypto.randomUUID();
  active = runId;
  runs.set(runId, { scenario: spec.id, status: "running", startedAt: new Date().toISOString() });
  res.json({ runId });

  (async () => {
    beginRun(runId);
    try {
      await ensureHub();
      bus.emitStudio(runId, { type: "run_started", scenario: spec.id, title: spec.title });
      const summary = await spec.run(runId, hub, params ?? {});
      runs.set(runId, { ...runs.get(runId)!, status: "ok", summary });
      bus.emitStudio(runId, { type: "run_finished", status: "ok", summary });
    } catch (e) {
      const cancelled = /cancelled by the owner/.test((e as Error).message ?? "");
      const message = (e as Error).stack ?? String(e);
      if (!cancelled) console.error(message);
      runs.set(runId, { ...runs.get(runId)!, status: "error", summary: cancelled ? "cancelled by the owner" : message });
      bus.emitStudio(runId, { type: "error", message: cancelled ? "Run cancelled by the owner. Nothing unapproved was executed." : (e as Error).message });
      bus.emitStudio(runId, { type: "run_finished", status: "error", summary: cancelled ? "Cancelled by the owner" : (e as Error).message });
    } finally {
      endRun(runId);
      active = null;
    }
  })();
});

app.post("/api/runs/:id/cancel", (req, res) => {
  const ok = cancelRun(req.params.id);
  res.status(ok ? 200 : 404).json({ ok, activeRun: active });
});
app.post("/api/runs/active/reply", (req, res) => {
  const text = String((req.body as { text?: string })?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "empty reply" });
  const ok = deliverReply(text);
  res.status(ok ? 200 : 409).json({ ok, error: ok ? undefined : "no agent is waiting for a reply" });
});
app.post("/api/runs/active/end", (_req, res) => res.json({ ok: endConversation() }));
app.post("/api/runs/cancel-active", (_req, res) => {
  const id = active;
  const ok = id ? cancelRun(id) : false;
  res.status(ok ? 200 : 404).json({ ok, runId: id });
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const since = Number(req.query.since ?? 0);
  for (const e of bus.replay(since)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  const onEvent = (e: Envelope) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on("event", onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    bus.off("event", onEvent);
  });
});

app.listen(env.port, "0.0.0.0", async () => {
  console.log(`AInstein console → http://localhost:${env.port}`);
  const missing = assertConfigured();
  if (missing.length) console.warn(`missing env: ${missing.join(", ")} (runs will be refused until set)`);
  try {
    await ensureHub();
  } catch (e) {
    console.warn(`MCP servers not reachable yet (${(e as Error).message}); will retry on first run`);
  }
});
