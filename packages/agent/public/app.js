/* AInstein console — live view of governed agents.
   The event stream from /events drives three things:
     1. the pipeline strip  (which agent is acting, which are done)
     2. the spotlight       (what is happening RIGHT NOW, pulsing while in progress)
     3. the action list     (one compact row per action with ArmorIQ's verdict) */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/* Public links: where judges see the results, and how they reach the owner for approvals. */
const CHANNELS = { Telegram: "https://t.me/+PV3TEFkYuPNjMWRl", Discord: "https://discord.gg/vqYfNTZhe" };
const OWNER = { name: "Prajwal", phone: "+91 63627 52965", whatsapp: "https://wa.me/916362752965", telegram: "https://t.me/+916362752965" };
const waLink = (id) => `${OWNER.whatsapp}?text=${encodeURIComponent(`Hi ${OWNER.name}, I'm testing AInstein. Please approve my held action${id ? ` (approval id ${id})` : ""}.`)}`;
const deliveredLinks = (set) => [...set].map((c) => `<a href="${CHANNELS[c]}" target="_blank" rel="noopener">Open ${c} ↗</a>`).join(" · ");

let config = null;
let lastSeq = 0;
let running = false;
let run = null;
let tick = null;

const LABELS = {
  research__get_brand_kit: "Read the brand kit", research__fetch_trends: "Look up trends", research__fetch_url: "Read a web page", research__get_analytics: "Check analytics",
  video__create_video: "Create a video with Remotion", video__edit_video: "Edit the video", video__preview_video: "Preview the video", video__render_final: "Render the final MP4",
  video__get_video_status: "Check video status", video__generate_voiceover: "Generate a voiceover", video__attach_voiceover: "Mix in the voiceover", video__export_source: "Export video source code",
  video__delete_project: "Delete a video project", video__list_projects: "List video projects",
  social__list_posts: "List workspace posts", social__draft_post: "Save a draft", social__schedule_post: "Schedule a post", social__publish_post: "Publish in the workspace",
  social__fetch_comments: "Read comments", social__reply_comment: "Reply to a comment", social__delete_post: "Delete a post", social__get_posting_rules: "Read the posting rules",
  telegram__tg_send_message: "Post to Telegram", telegram__tg_send_video: "Send the video to Telegram", telegram__tg_send_photo: "Send a photo to Telegram",
  telegram__tg_delete_message: "Delete a Telegram message", telegram__tg_edit_message_text: "Edit a Telegram message", telegram__tg_get_me: "Check the Telegram bot", telegram__tg_get_chat: "Check the Telegram channel",
  discord__discord_send: "Post to Discord", discord__discord_read_messages: "Read Discord messages", discord__discord_delete_message: "Delete a Discord message",
  discord__discord_get_server_info: "Check the Discord server", discord__discord_add_reaction: "React on Discord",
};
const ICON = { research: "🔎", video: "🎬", social: "📝", telegram: "✈️", discord: "💬" };
const ROLE = { planner: "Planner", creator: "Creator", publisher: "Publisher", editor: "Editor (delegated)", owner: "Owner" };
const beatClass = (b) => (/HELD|HOLD/.test(b) ? "hold" : /BLOCK/.test(b) ? "block" : /DELEG/.test(b) ? "info" : "allow");
const label = (t) => LABELS[t] ?? `${t.split("__")[0]}: ${(t.split("__")[1] ?? t).replace(/^(tg_|discord_)/, "").replace(/_/g, " ")}`;
const icon = (t) => ICON[t.split("__")[0]] ?? "🔧";
function why(e) {
  const r = e.reason ?? "";
  if (/tool-not-in-plan/.test(r)) return "Not in the plan ArmorIQ signed";
  if (/unknown tool/.test(r)) return "No such tool";
  if (/tool_not_in_policy_intersection|no_matching_policy/.test(r)) return "Refused by ArmorIQ policy";
  if (/allow_with_logging/.test(r)) return "Allowed by ArmorIQ policy";
  if (/covered by the owner's approval/.test(r)) return "Covered by your approval of this plan";
  if (/owner rule/.test(r)) return "Needs your approval";
  if (/approval request could not be filed/.test(r)) return "ArmorIQ could not record an approval request";
  if (/delegated scope/.test(r)) return e.action === "allow" ? "Covered by the delegated token" : "Outside what was delegated";
  if (/expired/.test(r)) return "Delegated token expired";
  return r.replace(/_/g, " ").slice(0, 80);
}

/* ───────── config / left column ───────── */
async function loadConfig() {
  config = await (await fetch("/api/config")).json();
  $("#statusPills").innerHTML = config.missing.length
    ? `<span class="pill warn">Missing: ${esc(config.missing.join(", "))}</span>`
    : `<span class="pill ok">ArmorIQ connected</span><span class="pill">${new Set(config.tools.map((t) => t.split("__")[0])).size} MCP servers · ${config.tools.length} tools</span>`;
  const list = $("#scenarios");
  list.innerHTML = "";
  for (const s of config.scenarios.filter((x) => !["custom", "video_to_telegram", "publish_now", "campaign", "proof"].includes(x.id))) {
    const b = document.createElement("button");
    b.className = "scn";
    b.innerHTML = `<span class="t">${esc(s.title)}</span><span class="beat ${beatClass(s.beat)}">${esc(s.beat)}</span><span class="d">${esc(shortDesc(s))}</span>`;
    b.onclick = () => {
      if (["campaign", "video_to_telegram", "publish_now"].includes(s.id)) {
        const brief = $("#brief").value.trim();
        if (!brief) {
          $("#brief").focus();
          $("#brief").style.borderColor = "var(--block)";
          setTimeout(() => ($("#brief").style.borderColor = ""), 1500);
          return;
        }
        startRun(s.id, { brief });
      } else startRun(s.id, {});
    };
    list.appendChild(b);
  }
  const hint = { planner: "Planner · research and drafts", creator: "Creator · makes videos and captions", publisher: "Publisher · posts to the channels" };
  $("#role").innerHTML = config.roles.filter((r) => r.name !== "editor").map((r) => `<option value="${r.name}" ${r.name === "creator" ? "selected" : ""}>${esc(hint[r.name] ?? r.label)}</option>`).join("");
  loadReadiness();
}
function shortDesc(s) {
  const map = {
    campaign: "Planner → Creator → Publisher. Everything allowed, everything logged.",
    video_to_telegram: "Make a real video, render it, send it to every connected channel. Render and sends wait for your approval.",
    publish_now: "Writes a post about your brief and sends it to every channel. Waits for your approval first.",
    creator_publish: "The Creator tries to publish. ArmorIQ refuses it.",
    injection: "A web page tries to hijack the Planner. The plan does not allow it.",
    scope_creep: "You add a delete mid-task. It was never in the signed plan.",
    delegation: "A freelancer edits under a delegated token and is stopped at its edge.",
  };
  return map[s.id] ?? s.description;
}
async function loadReadiness() {
  const el = $("#readiness");
  $("#rulesSummary").textContent = "checking…";
  try {
    const r = await fetch("/api/readiness");
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    const ok = j.results.filter((x) => x.ok).length;
    $("#rulesSummary").textContent = `${ok}/${j.results.length} as expected`;
    $("#rulesSummary").style.color = ok === j.results.length ? "var(--allow)" : "var(--hold)";
    el.innerHTML = j.results.map((x) => `<div class="rule ${x.ok ? "ok" : "bad"}"><i>${x.ok ? "✓" : "✗"}</i><div>${esc(ROLE[x.role])} → ${esc(label(x.tool))}<div class="muted small">should ${x.expect}</div></div><span class="v ${x.actual}">${esc(x.actual)}</span></div>`).join("");
  } catch (e) {
    $("#rulesSummary").textContent = "unavailable";
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
function needBrief() {
  const brief = $("#brief").value.trim();
  if (!brief) { $("#brief").focus(); $("#brief").style.borderColor = "var(--block)"; setTimeout(() => ($("#brief").style.borderColor = ""), 1500); return null; }
  return brief;
}
$("#makeVideo").onclick = () => { const b = needBrief(); if (b) startRun("video_to_telegram", { brief: b }); };
$("#makePost").onclick = () => { const b = needBrief(); if (b) startRun("publish_now", { brief: b }); };
$("#brief").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#makeVideo").click(); });
$("#scnToggle").onclick = () => { $("#scenarios").classList.toggle("hidden"); $("#scnToggle .small").textContent = $("#scenarios").classList.contains("hidden") ? "show" : "hide"; };
$("#askToggle").onclick = () => { $("#askBody").classList.toggle("hidden"); };
function showReply(role) {
  $("#replyWho").textContent = ROLE[role] ?? "The agent";
  $("#replyBox").classList.remove("hidden");
  $("#replyText").focus();
  // The run is idle while waiting: allow starting something new (that closes this conversation).
  running = false;
  $("#liveBadge").classList.add("hidden");
  $("#runEyebrow").textContent = "Waiting for your reply";
  if (!tick) tick = setInterval(renderSpot, 1000);
  document.querySelectorAll(".scn, #runCustom, #makeVideo, #makePost").forEach((b) => (b.disabled = false));
}
function hideReply() { $("#replyBox").classList.add("hidden"); }
$("#replySend").onclick = async () => {
  const text = $("#replyText").value.trim();
  if (!text) { $("#replyText").focus(); return; }
  $("#replySend").disabled = true;
  const r = await fetch("/api/runs/active/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  $("#replySend").disabled = false;
  if (r.ok) { $("#replyText").value = ""; hideReply(); }
};
$("#replyText").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#replySend").click(); } });
$("#replyEnd").onclick = async () => { await fetch("/api/runs/active/end", { method: "POST" }); hideReply(); };
$("#newRun").onclick = async () => {
  if (running) await fetch("/api/runs/cancel-active", { method: "POST" });
  else await fetch("/api/runs/active/end", { method: "POST" });
  hideReply();
  setRunning(false);
  run = null;
  $("#timeline").innerHTML = `<div class="empty">Actions appear here as the agents work.</div>`;
  $("#pipeline").innerHTML = "";
  $("#runEyebrow").textContent = "Idle";
  $("#runTitle").textContent = "Pick something to run";
  ["#cAllow", "#cHold", "#cBlock"].forEach((id) => ($(id).textContent = "0"));
  spot("idle", "●", "Nothing running", "Type a topic on the left, or talk to one agent. Every action is checked by ArmorIQ.", "");
  $("#brief").focus();
};
$("#rulesToggle").onclick = () => $("#readiness").classList.toggle("hidden");
$("#showThoughts").onchange = (e) => document.body.classList.toggle("thoughts", e.target.checked);
$("#reset").onclick = async () => { await fetch("/api/reset", { method: "POST" }); loadWorld(); };
$("#runCustom").onclick = () => {
  const goal = $("#goal").value.trim();
  if (!goal) { $("#goal").focus(); $("#goal").style.borderColor = "var(--block)"; setTimeout(() => ($("#goal").style.borderColor = ""), 1500); return; }
  startRun("custom", { role: $("#role").value, goal, followUp: $("#followUp").value.trim() || undefined });
};
$("#goal").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#runCustom").click(); });
$("#cancelRun").onclick = async () => { $("#cancelRun").disabled = true; await fetch("/api/runs/cancel-active", { method: "POST" }); setTimeout(() => ($("#cancelRun").disabled = false), 1500); };

let lastAsk = "";
async function startRun(scenario, params) {
  if (running) return;
  lastAsk = (params?.brief ?? params?.goal ?? "").trim();
  setRunning(true);
  const r = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario, params }) });
  const j = await r.json();
  if (!r.ok) { spot("block", "⚠️", "Could not start", j.error, "error"); setRunning(false); }
}
function setRunning(v) {
  running = v;
  document.querySelectorAll(".scn, #runCustom, #makeVideo, #makePost").forEach((b) => (b.disabled = v));
  $("#cancelRun").classList.toggle("hidden", !v);
  $("#liveBadge").classList.toggle("hidden", !v);
  if (v && !tick) tick = setInterval(renderSpot, 1000);
  if (!v && tick) { clearInterval(tick); tick = null; }
}

/* ───────── run state ───────── */
function newRun(e) {
  run = { id: e.runId, title: e.title, counts: { allow: 0, hold: 0, block: 0 }, agents: [], current: null, nodes: [], delivered: new Set(), startedAt: Date.now(), state: { kind: "working", text: "Starting", since: Date.now() } };
  $("#timeline").innerHTML = lastAsk ? `<div class="ask"><div class="who">You</div>${esc(lastAsk)}</div>` : "";
  $("#runEyebrow").textContent = "Running";
  $("#runTitle").textContent = e.title;
  updateCounters();
  renderPipeline();
  renderSpot();
}
function updateCounters() {
  if (!run) return;
  $("#cAllow").textContent = run.counts.allow;
  $("#cHold").textContent = run.counts.hold;
  $("#cBlock").textContent = run.counts.block;
}

/* pipeline strip: Owner → agents in order → Delivered */
function renderPipeline() {
  if (!run) return;
  const nodes = [{ key: "owner", label: "You", cls: "done", av: "Y" }];
  for (const a of run.agents) nodes.push({ key: a.role, label: ROLE[a.role] ?? a.role, cls: a.status, av: (ROLE[a.role] ?? a.role)[0], status: a.statusText });
  nodes.push({ key: "delivered", label: "Delivered", cls: run.delivered.size ? "done" : "", av: "✓", status: [...run.delivered].join(" · ") });
  $("#pipeline").innerHTML = nodes
    .map((n, i) => `${i ? `<div class="link ${n.cls === "active" || n.cls === "waiting" ? "active" : n.cls === "done" ? "done" : ""}"></div>` : ""}<div class="node ${n.key} ${n.cls}"><div class="avatar">${esc(n.av)}</div><div class="label">${esc(n.label)}</div><div class="status">${esc(n.status ?? "")}</div></div>`)
    .join("");
}
function currentAgent() {
  return run?.current;
}
function setAgentStatus(a, status, statusText) {
  a.status = status;
  a.statusText = statusText ?? "";
  renderPipeline();
}

/* spotlight */
function setState(kind, text, extra = {}) {
  if (!run) return;
  run.state = { kind, text, since: Date.now(), ...extra };
  renderSpot();
}
function renderSpot() {
  if (!run) return;
  const s = run.state;
  const a = currentAgent();
  const who = a ? ROLE[a.role] ?? a.role : "";
  const elapsed = Math.round((Date.now() - s.since) / 1000);
  const mmss = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  const map = {
    thinking: ["working", "💭", `${who} is thinking`, s.text || "Deciding what to do next.", `thinking ${mmss(elapsed)}`, true],
    checking: ["working", icon(s.tool ?? "x__"), `${label(s.tool ?? "")}`, "Asking ArmorIQ whether this is allowed…", "checking", true],
    running: ["working", icon(s.tool ?? "x__"), `${label(s.tool ?? "")}`, s.text || "Allowed. The tool is running.", `running ${mmss(elapsed)}`, true],
    waiting: ["waiting", "⏸", `${label(s.tool ?? "")} is on hold`, `Waiting for the owner to approve it on <a href="${esc(config?.platformUrl ?? "#")}" target="_blank" rel="noopener">platform.armoriq.ai</a> → Held Actions (approval id ${esc(s.id ?? "")}).<br><b>Trying this as a judge?</b> Message ${OWNER.name} to approve: <a href="${waLink(s.id)}" target="_blank" rel="noopener">WhatsApp ↗</a> · <a href="${OWNER.telegram}" target="_blank" rel="noopener">Telegram ↗</a>`, `waiting ${mmss(elapsed)}`, false],
    blocked: ["block", "⛔", `${label(s.tool ?? "")} was blocked`, s.text || "ArmorIQ refused it. Nothing was executed.", "blocked", false],
    allowed: ["allow", "✅", `${label(s.tool ?? "")} done`, s.text || "", "done", false],
    handoff: ["working", "🤝", s.text || "Handing over", "Next agent is starting.", "handoff", true],
    done: ["done", "🏁", run.delivered.size ? `Run finished · delivered to ${[...run.delivered].join(" and ")}` : "Run finished", run.delivered.size ? `${deliveredLinks(run.delivered)}<br>${esc(s.text || "")}` : esc(s.text || ""), `finished in ${mmss(Math.round((Date.now() - run.startedAt) / 1000))}`, false],
    error: ["block", "⚠️", s.text || "Run failed", s.detail || "", "error", false],
    working: ["working", "●", s.text || "Working", "", "working", true],
    yourturn: run.delivered.size
      ? ["allow", "🎉", `Delivered to ${[...run.delivered].join(" and ")}`, `It's live. ${deliveredLinks(run.delivered)}<br>Want a change? Reply below (same signed plan). Otherwise press End run or ＋ New run.`, `closes in ${mmss(Math.max(0, 300 - elapsed))}`, false]
      : ["yourturn", "💬", `${who} finished and is waiting for you`, "Reply below to continue under the same signed plan. Press End run or ＋ New run when you are done.", `closes in ${mmss(Math.max(0, 300 - elapsed))}`, false],
  };
  const [cls, ico, title, sub, state, typing] = map[s.kind] ?? map.working;
  const el = $("#spotlight");
  el.className = `spotlight ${cls}`;
  $("#spotIcon").textContent = ico;
  $("#spotTitle").textContent = title;
  $("#spotSub").innerHTML = sub;
  $("#spotState").innerHTML = `<span class="sdot"></span>${esc(state)}${typing ? '<span class="typing"><i></i><i></i><i></i></span>' : ""}`;
}
function spot(cls, ico, title, sub, state) {
  const el = $("#spotlight");
  el.className = `spotlight ${cls}`;
  $("#spotIcon").textContent = ico;
  $("#spotTitle").textContent = title;
  $("#spotSub").textContent = sub;
  $("#spotState").innerHTML = `<span class="sdot"></span>${esc(state)}`;
}

/* action list */
function agentCard(role, goal, agentId) {
  const a = { role, goal, agentId, status: "active", statusText: "starting", pending: [], el: null, body: null, rows: 0 };
  for (const other of run.agents) if (other.status === "active") setAgentStatus(other, "done", "done");
  const el = document.createElement("div");
  el.className = "agent";
  el.innerHTML = `<div class="agent-head"><div class="av ${esc(role)}">${esc((ROLE[role] ?? role)[0])}</div><div class="who">${esc(ROLE[role] ?? role)}</div><div class="goal" title="${esc(goal ?? "")}">${esc(goal ?? "")}</div><div class="st">working</div></div><div class="agent-body"></div>`;
  el.querySelector(".agent-head").onclick = () => el.classList.toggle("collapsed");
  const tl = $("#timeline");
  if (tl.querySelector(".empty")) tl.innerHTML = "";
  for (const other of run.agents) other.el?.classList.add("collapsed");
  tl.appendChild(el);
  a.el = el;
  a.body = el.querySelector(".agent-body");
  run.agents.push(a);
  run.current = a;
  renderPipeline();
  return a;
}
function row(a, { cls = "", ico = "", label: lab = "", sub = "", chip = "", chipCls = "wait", details = "", pending = false }) {
  const el = document.createElement("div");
  el.className = `item ${cls} ${pending ? "pending" : ""} ${details ? "clickable" : ""}`;
  el.innerHTML = `<div class="ico">${ico}</div><div><div class="label">${lab}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div><div>${chip ? `<span class="chip ${chipCls}">${chip}</span>` : ""}</div>${details ? `<div class="details">${details}</div>` : ""}`;
  if (details) el.onclick = () => el.classList.toggle("open");
  a.body.appendChild(el);
  a.rows++;
  a.el.querySelector(".st").textContent = `${a.rows} actions`;
  el.scrollIntoView({ block: "nearest" });
  return el;
}
function setChip(el, text, cls) {
  let c = el.querySelector(".chip");
  if (!c) { c = document.createElement("span"); el.children[2].appendChild(c); }
  c.textContent = text;
  c.className = `chip ${cls}`;
  el.classList.remove("pending");
}
function setSub(el, html) {
  let s = el.querySelector(".sub");
  if (!s) { s = document.createElement("div"); s.className = "sub"; el.children[1].appendChild(s); }
  s.innerHTML = html;
}
function addDetails(el, html) {
  let d = el.querySelector(".details");
  if (!d) { d = document.createElement("div"); d.className = "details"; el.appendChild(d); el.classList.add("clickable"); el.onclick = () => el.classList.toggle("open"); }
  d.insertAdjacentHTML("beforeend", html);
}
function pendingRow(a, tool) {
  return [...a.pending].reverse().find((x) => x.dataset.tool === tool);
}

/* ───────── event handling ───────── */
function handle(e) {
  switch (e.type) {
    case "run_started": newRun(e); break;
    case "agent_started": {
      const a = agentCard(e.role, e.goal, e.agentId);
      setAgentStatus(a, "active", "planning");
      setState("thinking", "Reading the task and declaring a plan.");
      break;
    }
    case "plan_declared": {
      const a = currentAgent(); if (!a) break;
      row(a, { cls: "plan", ico: "🗒️", label: `Declares ${e.steps.length} planned action${e.steps.length === 1 ? "" : "s"}`, sub: `<div class="chips">${e.steps.map((s) => `<span>${esc(label(s.tool))}</span>`).join("")}</div>`, details: e.steps.map((s) => `<div class="kv"><b>${esc(label(s.tool))}</b> — ${esc(s.purpose)}</div>`).join("") });
      setState("checking", "", { tool: "armoriq__sign" });
      $("#spotTitle").textContent = "Sending the plan to ArmorIQ";
      break;
    }
    case "token_minted": {
      const a = currentAgent(); if (!a) break;
      row(a, { cls: "plan", ico: "🔏", label: "ArmorIQ signed the plan", sub: `Only these ${e.steps.length} actions are authorised`, chip: "SIGNED", chipCls: "info", details: `<div class="kv"><b>Token</b> ${esc(e.tokenId)}</div><div class="kv"><b>Plan hash</b> ${esc(e.planHash)}</div><div class="kv"><b>Expires</b> ${new Date(e.expiresAt * 1000).toLocaleTimeString()}</div><div class="kv"><b>Mode</b> ${esc(e.mode)}</div>` });
      setAgentStatus(a, "active", "acting");
      setState("thinking", "Plan signed. Choosing the first action.");
      break;
    }
    case "delegation_created": {
      const a = currentAgent() ?? agentCard("publisher", "Delegation", "");
      row(a, { cls: "plan", ico: "🤝", label: `Delegates to the Editor: ${e.allowedActions.map((x) => esc(x.replace(/_/g, " "))).join(", ")} only`, sub: `Child tokens signed by ArmorIQ · expire ${new Date(e.expiresAt * 1000).toLocaleTimeString()}`, chip: "DELEGATED", chipCls: "info", details: `<div class="kv"><b>Delegation</b> ${esc(e.delegationId)}</div><div class="kv"><b>Parent token</b> ${esc(e.parentTokenId)}</div>` });
      setState("handoff", "Delegating to the Editor");
      break;
    }
    case "handoff": {
      const a = currentAgent(); if (a) setAgentStatus(a, "done", "done");
      setState("handoff", `${ROLE[e.from] ?? e.from} hands over to the ${ROLE[e.to] ?? e.to}`);
      break;
    }
    case "awaiting_reply": {
      const a = currentAgent(); if (a) setAgentStatus(a, "waiting", "your turn");
      setState("yourturn", "");
      showReply(e.role);
      break;
    }
    case "owner_message": {
      hideReply();
      $("#timeline").insertAdjacentHTML("beforeend", `<div class="ask"><div class="who">You</div>${esc(e.text)}</div>`);
      $("#runEyebrow").textContent = "Running";
      setRunning(true);
      const a = currentAgent(); if (!a) break;
      setAgentStatus(a, "active", "acting");
      // Continue the SAME agent in a new card below your message, so the page reads top to bottom.
      const el = document.createElement("div");
      el.className = "agent";
      el.innerHTML = `<div class="agent-head"><div class="av ${esc(a.role)}">${esc((ROLE[a.role] ?? a.role)[0])}</div><div class="who">${esc(ROLE[a.role] ?? a.role)}</div><div class="goal">continuing under the same signed plan</div><div class="st">working</div></div><div class="agent-body"></div>`;
      el.querySelector(".agent-head").onclick = () => el.classList.toggle("collapsed");
      $("#timeline").appendChild(el);
      a.el = el; a.body = el.querySelector(".agent-body"); a.rows = 0; a.pending = [];
      setState("thinking", "Reading your new instruction.");
      break;
    }
    case "tool_call": {
      const a = currentAgent(); if (!a) break;
      const el = row(a, { ico: icon(e.tool), label: esc(label(e.tool)), chip: "checking", chipCls: "wait", pending: true });
      addDetails(el, `<div class="kv"><b>Tool</b> ${esc(e.tool)}</div><pre>${esc(JSON.stringify(e.args, null, 1))}</pre>`);
      el.dataset.tool = e.tool;
      a.pending.push(el);
      setState("checking", "", { tool: e.tool });
      break;
    }
    case "decision": {
      const a = currentAgent(); if (!a) break;
      const el = pendingRow(a, e.tool) ?? row(a, { ico: icon(e.tool), label: esc(label(e.tool)) });
      run.counts[e.action]++; updateCounters();
      if (e.action === "allow") {
        setChip(el, "ALLOWED", "allow"); el.classList.add("allow", "pending");
        setSub(el, `${esc(why(e))}${e.matchedPolicy ? ` <span class="muted">· ${esc(e.matchedPolicy)}</span>` : ""}`);
        setState("running", "", { tool: e.tool });
      } else if (e.action === "hold") {
        setChip(el, "HELD", "hold"); el.classList.add("hold", "pending");
        setSub(el, `${esc(why(e))} · waiting on the ArmorIQ dashboard${e.delegationId ? ` · id ${esc(e.delegationId.slice(0, 8))}…` : ""}`);
        setAgentStatus(a, "waiting", "awaiting approval");
        setState("waiting", "", { tool: e.tool, id: e.delegationId });
      } else {
        setChip(el, "BLOCKED", "block"); el.classList.add("block");
        setSub(el, `${esc(why(e))}${e.matchedPolicy ? ` <span class="muted">· ${esc(e.matchedPolicy)}</span>` : ""}`);
        a.pending = a.pending.filter((x) => x !== el);
        setState("blocked", `${why(e)}. Nothing was executed.`, { tool: e.tool });
        setTimeout(() => { if (run?.state.kind === "blocked") setState("thinking", "Deciding what to do after the refusal."); }, 2500);
      }
      addDetails(el, `<div class="kv"><b>ArmorIQ</b> ${esc(e.action)} (${esc(e.source)})${e.reason ? ` — ${esc(e.reason)}` : ""}${e.delegationId ? `<br><b>Approval id</b> ${esc(e.delegationId)}` : ""}</div>`);
      break;
    }
    case "approval": {
      const a = currentAgent(); if (!a) break;
      const el = pendingRow(a, e.tool);
      const m = { approved: ["APPROVED", "allow", "You approved it. Running now."], rejected: ["REJECTED", "block", "You rejected it. Nothing was executed."], timeout: ["TIMED OUT", "block", "No decision in time. Nothing was executed."] }[e.status];
      if (el) { setChip(el, m[0], m[1]); setSub(el, m[2]); el.classList.remove("hold"); el.classList.add(m[1]); if (e.status === "approved") el.classList.add("pending"); else a.pending = a.pending.filter((x) => x !== el); }
      setAgentStatus(a, "active", "acting");
      if (e.status === "approved") setState("running", "Approved. The tool is running.", { tool: e.tool });
      else setState("blocked", m[2], { tool: e.tool });
      break;
    }
    case "tool_result": {
      const a = currentAgent(); if (!a) break;
      const el = pendingRow(a, e.tool);
      if (el) {
        a.pending = a.pending.filter((x) => x !== el);
        el.classList.remove("pending");
        if (!e.ok) { setChip(el, "TOOL ERROR", "err"); setSub(el, esc(clip(e.preview.replace(/\s+/g, " "), 120))); }
        else { const extra = resultNote(e.tool, e.preview); if (extra) setSub(el, `${el.querySelector(".sub")?.innerHTML ?? ""} <span class="muted">· ${esc(extra)}</span>`); }
        addDetails(el, `<div class="kv"><b>Result</b></div><pre>${esc(e.preview)}</pre>`);
      }
      if (/telegram__tg_send|discord__discord_send/.test(e.tool)) deliveryBanner(e);
      setState(e.ok ? "allowed" : "blocked", e.ok ? resultNote(e.tool, e.preview) || "Done." : `Tool error: ${clip(e.preview.replace(/\s+/g, " "), 100)}`, { tool: e.tool });
      setTimeout(() => { if (run && ["allowed", "blocked"].includes(run.state.kind)) setState("thinking", "Deciding the next step."); }, 1800);
      break;
    }
    case "assistant": {
      const a = currentAgent(); if (!a) break;
      const t = e.text.trim();
      row(a, { cls: "say", ico: "💭", label: esc(clip(t, 220)), details: t.length > 220 ? `<pre>${esc(t)}</pre>` : "" });
      break;
    }
    case "agent_finished": {
      const a = currentAgent(); if (!a) break;
      row(a, { cls: "allow", ico: "✅", label: `${esc(ROLE[e.role] ?? e.role)} finished`, sub: esc(clip(e.answer.replace(/\s+/g, " "), 160)), details: `<pre>${esc(e.answer)}</pre>` });
      setAgentStatus(a, "done", "done");
      break;
    }
    case "run_finished": {
      hideReply();
      $("#runEyebrow").textContent = e.status === "ok" ? "Finished" : "Stopped";
      for (const a of run.agents) if (a.status !== "done") setAgentStatus(a, e.status === "ok" ? "done" : "blocked", e.status === "ok" ? "done" : "stopped");
      setState(e.status === "ok" ? "done" : "error", e.status === "ok" ? clip((e.summary ?? "").replace(/\s+/g, " "), 160) : "Run stopped", { detail: e.summary });
      setRunning(false);
      loadWorld();
      break;
    }
    case "error": {
      if (run) setState("error", e.message);
      else spot("block", "⚠️", "Error", e.message, "error");
      setRunning(false);
      break;
    }
  }
}
/* A clear, unmissable confirmation in the action list whenever a channel send succeeds or fails. */
function deliveryBanner(e) {
  const channel = e.tool.startsWith("telegram") ? "Telegram" : "Discord";
  const what = /video/.test(e.tool) ? "The video" : /photo/.test(e.tool) ? "The image" : "The post";
  const confirmed = e.ok && (/"message_id"/.test(e.preview) || /successfully sent|message sent/i.test(e.preview)) && !/"ok"\s*:\s*false/.test(e.preview);
  if (confirmed) { run.delivered.add(channel); renderPipeline(); }
  const html = confirmed
    ? `<div class="delivered ok"><div class="dico">✅</div><div><b>${what} reached ${channel}</b><div class="dsub">Delivered at ${new Date().toLocaleTimeString()} · <a href="${CHANNELS[channel]}" target="_blank" rel="noopener">open ${channel} ↗</a></div></div></div>`
    : `<div class="delivered bad"><div class="dico">⚠️</div><div><b>${what} did not reach ${channel}</b><div class="dsub">${esc(clip(e.preview.replace(/\s+/g, " "), 140))}</div></div></div>`;
  $("#timeline").insertAdjacentHTML("beforeend", html);
  $("#timeline").lastElementChild.scrollIntoView({ block: "nearest" });
}
function resultNote(tool, preview) {
  try {
    const j = JSON.parse(preview);
    if (j.postId) return `post ${j.postId} ${j.status ?? ""}`.trim();
    if (j.message_id) return `Telegram message ${j.message_id}`;
    if (j.mp4Url) return "MP4 ready";
    if (j.voiceoverId) return `voiceover ${j.characters} chars`;
    if (j.projectId) return "video project created";
  } catch {
    if (/successfully sent/i.test(preview)) return "delivered to Discord";
  }
  return "";
}

/* ───────── right column ───────── */
let flashTimer = null;
function flashDelivered() {
  loadWorld();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => document.querySelectorAll(".dl.flash").forEach((d) => d.classList.remove("flash")), 1500);
}
async function loadWorld() {
  if (!$("#delivered") && !$("#feed") && !$("#library")) return;
  try {
    const posts = await (await fetch("/api/feed")).json();
    const lib = await (await fetch("/api/library")).json();
    const byStatus = (s) => posts.filter((p) => p.status === s).length;
    const mcps = new Set((config?.tools ?? []).map((t) => t.split("__")[0]));
    const d = run?.delivered ?? new Set();
    $("#delivered").innerHTML = [
      mcps.has("telegram") ? ["✈️", "Telegram channel", "real channel via public MCP", d.has("Telegram")] : null,
      mcps.has("discord") ? ["💬", "Discord server", "real server via public MCP", d.has("Discord")] : null,
      ["📝", "Workspace", `${byStatus("draft")} drafts · ${byStatus("scheduled")} scheduled · ${byStatus("published")} published`, false],
      ["🎬", "Videos", `${lib.filter((v) => !v.deleted).length} ready`, false],
    ].filter(Boolean).map(([i, n, s, hit]) => `<div class="dl ${hit ? "flash" : ""}"><span>${i}</span><div><div class="n">${esc(n)}</div><div class="s">${esc(s)}</div></div>${hit ? `<b class="cnt">sent</b>` : ""}</div>`).join("");
    const feed = $("#feed");
    feed.innerHTML = posts.length ? "" : `<div class="empty">No posts yet</div>`;
    for (const p of [...posts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)) {
      const plat = { telegram: "✈️ Telegram", discord: "💬 Discord" }[p.platform] ?? p.platform;
      feed.insertAdjacentHTML("beforeend", `<div class="post"><div class="head"><span>${esc(plat)}</span><span class="st ${esc(p.status)}">${esc(p.status)}</span></div><div class="cap">${esc(p.caption)}</div>${p.mediaUrl ? `<a href="${esc(p.mediaUrl)}" target="_blank" rel="noopener">open media</a>` : ""}</div>`);
    }
    const le = $("#library");
    le.innerHTML = lib.length ? "" : `<div class="empty">No videos yet</div>`;
    for (const v of [...lib].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4)) {
      le.insertAdjacentHTML("beforeend", `<div class="post"><div class="head"><span>${new Date(v.createdAt).toLocaleTimeString()}</span><span class="st ${v.deleted ? "draft" : "published"}">${v.deleted ? "deleted" : "ready"}</span></div><div class="cap">${esc(v.title)}</div><a href="${esc(v.previewUrl ?? "#")}" target="_blank" rel="noopener">preview</a></div>`);
    }
  } catch {
    $("#feed").innerHTML = `<div class="empty">MCP host unreachable</div>`;
  }
}

/* ───────── event stream ───────── */
function connect() {
  const es = new EventSource(`/events?since=${lastSeq}`);
  const buffer = [];
  let live = false;
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    lastSeq = Math.max(lastSeq, e.seq ?? 0);
    if (!live) {
      buffer.push(e);
      clearTimeout(connect._t);
      connect._t = setTimeout(() => {
        live = true;
        const idx = buffer.map((x, i) => (x.type === "run_started" ? i : -1)).filter((i) => i >= 0).pop();
        if (idx !== undefined) {
          for (const x of buffer.slice(idx)) handle(x);
          if (buffer[buffer.length - 1].type !== "run_finished") setRunning(true);
        }
      }, 300);
      return;
    }
    handle(e);
  };
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}

loadConfig().then(() => { connect(); loadWorld(); });
