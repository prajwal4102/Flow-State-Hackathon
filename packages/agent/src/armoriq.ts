import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import armoriq from "@armoriq/sdk";
import type { ArmorIQClient as ArmorIQClientType, ArmorIQSession as ArmorIQSessionType, IntentToken as IntentTokenType, EnforceResult } from "@armoriq/sdk";
import { env, repoRoot, type RoleName } from "./env.js";
import type { DecisionSource } from "./events.js";
import { McpHub, splitToolName, type ToolOutcome } from "./mcpHub.js";
import { currentSignal } from "./runControl.js";

// The SDK ships as CommonJS without an exports map; destructure from the default import for ESM safety.
const { ArmorIQClient, IntentToken, DelegationException } = armoriq;

export interface Decision {
  action: "allow" | "block" | "hold";
  source: DecisionSource;
  reason?: string;
  matchedPolicy?: string;
  delegationId?: string;
}

export interface TokenInfo {
  tokenId: string;
  planHash: string;
  planId?: string;
  expiresAt: number;
  steps: string[];
  mode: string;
}

/**
 * A Governor is the ONLY path from an agent's decision to a tool execution.
 *
 *   plan()   → declares the agent's intent and mints a signed intent token
 *   check()  → ArmorIQ decides allow / hold / block for this tool call
 *   execute()→ runs the tool (direct MCP call in sdk mode, proxy.armoriq.ai in proxy mode)
 *   report() → writes the audit record
 */
export interface CheckOptions {
  /** Evaluate only; never file an approval request (used by the readiness probe). */
  dryRun?: boolean;
}

export interface Governor {
  readonly role: RoleName;
  readonly agentId: string;
  plan(toolNames: string[], goal: string): Promise<TokenInfo | null>;
  check(toolName: string, args: Record<string, unknown>, opts?: CheckOptions): Promise<Decision>;
  awaitApproval(delegationId: string): Promise<"approved" | "rejected" | "timeout">;
  execute(toolName: string, args: Record<string, unknown>, approvedDelegationId?: string): Promise<ToolOutcome>;
  report(toolName: string, args: Record<string, unknown>, outcome: ToolOutcome, durationMs: number): Promise<void>;
  close(): Promise<void>;
}

const clients = new Map<RoleName, ArmorIQClientType>();

/**
 * Owner-defined hold rules (armoriq/holds.json): tools that must wait for the
 * owner's approval on the ArmorIQ dashboard even when the platform policy
 * allows them. The approval request, its status and its expiry all live in
 * ArmorIQ; this file only says which calls are sensitive enough to ask.
 */
const holdRules: Record<string, string[]> = (() => {
  try {
    const file = path.join(repoRoot, "armoriq", "holds.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    return out;
  } catch {
    return {};
  }
})();

export function holdsFor(role: RoleName): string[] {
  return holdRules[role] ?? [];
}

export function clientFor(role: RoleName): ArmorIQClientType {
  let c = clients.get(role);
  if (!c) {
    if (!env.armoriq.apiKey) throw new Error("ARMORIQ_API_KEY is not set");
    c = new ArmorIQClient({
      apiKey: env.armoriq.apiKey,
      userId: env.armoriq.userEmail,
      agentId: env.armoriq.agents[role],
      useProduction: true,
    });
    clients.set(role, c);
  }
  return c;
}

function describeError(e: unknown): string {
  const err = e as { message?: string; response?: { status?: number; data?: unknown } };
  const data = err.response?.data;
  const body = data ? ` ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}` : "";
  return `${err.message ?? String(e)}${err.response?.status ? ` [HTTP ${err.response.status}]` : ""}${body}`;
}

/**
 * Governor for first-party agents (Planner, Creator, Publisher).
 * Wraps ArmorIQSession in `sdk` or `proxy` mode.
 */
export class SessionGovernor implements Governor {
  readonly agentId: string;
  private session: ArmorIQSessionType;
  private client: ArmorIQClientType;

  constructor(readonly role: RoleName, private hub: McpHub) {
    this.client = clientFor(role);
    this.agentId = env.armoriq.agents[role];
    this.session = this.client.forUser(env.armoriq.userEmail).startSession({
      mode: env.armoriq.mode,
      llm: env.llm.model,
      validitySeconds: env.armoriq.tokenValiditySeconds,
      // Re-mint on plan change instead of relying on the newer delta-chain infra.
      trueReanchor: false,
    });
  }

  private goal = "";

  async plan(toolNames: string[], goal: string): Promise<TokenInfo | null> {
    if (toolNames.length === 0) return null;
    this.goal = goal;
    // ArmorIQ's Held Actions view labels a request by the plan's FIRST step. Put the steps that need
    // the owner's approval first so the dashboard shows the action actually being approved.
    // Order does not affect enforcement: plan membership is a set, and proxy proofs are looked up by action.
    const held = holdsFor(this.role);
    const ordered = [...toolNames.filter((t) => held.includes(t)), ...toolNames.filter((t) => !held.includes(t))];
    const token = await this.session.startPlan(
      ordered.map((name) => ({ name, args: {} })),
      goal,
    );
    return { tokenId: token.tokenId, planHash: token.planHash, planId: token.planId, expiresAt: token.expiresAt, steps: toolNames, mode: env.armoriq.mode };
  }

  /** One readable line for the approver: what is being done, and for which task. */
  private approvalReason(toolName: string, args: Record<string, unknown>): string {
    const { mcp, tool } = splitToolName(toolName);
    const what: Record<string, string> = {
      render_final: "Render the final MP4",
      publish_post: "Publish a post",
      schedule_post: "Schedule a post",
      reply_comment: "Reply publicly to a comment",
      tg_send_message: "Send a message to the Telegram channel",
      tg_send_video: "Send a video to the Telegram channel",
      tg_send_photo: "Send a photo to the Telegram channel",
      discord_send: "Send a message to the Discord channel",
    };
    const text = (args.text ?? args.caption ?? args.message ?? "") as string;
    const preview = typeof text === "string" && text ? ` — "${text.replace(/\s+/g, " ").slice(0, 90)}${text.length > 90 ? "…" : ""}"` : "";
    const task = this.goal ? ` · task: ${this.goal.replace(/\s+/g, " ").slice(0, 120)}` : "";
    return `${what[tool] ?? `${mcp} ${tool}`} (${this.agentId})${preview}${task}`;
  }

  async check(toolName: string, args: Record<string, unknown>, opts: CheckOptions = {}): Promise<Decision> {
    const r: EnforceResult = await this.session.check(toolName, args, env.armoriq.userEmail);
    const source: DecisionSource = r.reason?.startsWith("tool-not-in-plan") ? "intent-plan" : env.armoriq.mode === "proxy" ? "armoriq-proxy" : "armoriq-policy";
    if (r.action !== "allow" || !holdsFor(this.role).includes(toolName)) {
      return { action: r.action, source, reason: r.reason, matchedPolicy: r.matchedPolicy, delegationId: r.delegationId };
    }
    // ArmorIQ approvals are granted per signed plan ("you cannot approve a plan…"). Once the owner has
    // approved this plan, the remaining held steps of the same plan proceed on that approval.
    if (this.approvedDelegationId && !opts.dryRun) {
      return { action: "allow", source: "armoriq-approval", reason: `covered by the owner's approval of this plan (approval ${this.approvedDelegationId})`, matchedPolicy: "holds.json", delegationId: this.approvedDelegationId };
    }
    // Platform allowed it, but the owner's hold rules say this plan must be approved first.
    const reason = `owner rule: '${splitToolName(toolName).tool}' is audience-facing or costly and needs the owner's approval`;
    if (opts.dryRun) return { action: "hold", source: "armoriq-approval", reason, matchedPolicy: "holds.json" };
    const token = this.session.currentTokenValue;
    try {
      const req = await this.client.createDelegationRequest({
        tool: splitToolName(toolName).tool,
        action: "execute",
        arguments: args,
        amount: 0.01,
        requesterEmail: env.armoriq.requesterEmail,
        requesterRole: "agent_user",
        requesterLimit: 0,
        domain: splitToolName(toolName).mcp,
        planId: token?.planId,
        intentReference: token?.tokenId,
        merkleRoot: token?.planHash,
        reason: this.approvalReason(toolName, args),
      });
      return { action: "hold", source: "armoriq-approval", reason, matchedPolicy: "holds.json", delegationId: req.delegationId };
    } catch (e) {
      // Fail closed: if ArmorIQ cannot record the approval request, the action does not run.
      return { action: "block", source: "armoriq-approval", reason: `approval request could not be filed with ArmorIQ (${describeError(e)}); refusing to run without it` };
    }
  }

  /** Set once the owner approves a hold in this plan; later held steps of the plan ride on it. */
  private approvedDelegationId?: string;

  async awaitApproval(delegationId: string): Promise<"approved" | "rejected" | "timeout"> {
    const poll = this.session
      .awaitApproval(delegationId, { timeout: env.armoriq.holdTimeoutSeconds, interval: 3, userEmail: env.armoriq.requesterEmail })
      .then((status) => {
        if (status === "approved") this.approvedDelegationId = delegationId;
        return status;
      });
    const signal = currentSignal();
    if (!signal) return poll;
    // Let the owner abandon the wait from the console. The SDK's poll keeps running until its own timeout, harmlessly.
    const cancelled = new Promise<"timeout">((resolve) => {
      if (signal.aborted) resolve("timeout");
      else signal.addEventListener("abort", () => resolve("timeout"), { once: true });
    });
    return Promise.race([poll, cancelled]);
  }

  async execute(toolName: string, args: Record<string, unknown>, approvedDelegationId?: string): Promise<ToolOutcome> {
    if (env.armoriq.mode === "sdk") {
      return this.hub.call(toolName, args);
    }
    // proxy mode: the ArmorIQ proxy verifies the Merkle inclusion proof for this step and forwards to the registered MCP server.
    const token = this.session.currentTokenValue;
    if (!token) return { ok: false, text: "no intent token; plan() must run first" };
    const { mcp, tool } = splitToolName(toolName);
    const params = approvedDelegationId ? { ...args, _delegation_id: approvedDelegationId, _approvals: 999 } : args;
    try {
      const res = await this.client.invoke(mcp, tool, token, params, undefined, env.armoriq.userEmail);
      const content = (res.result as { content?: Array<{ type: string; text?: string }> })?.content;
      const text = Array.isArray(content) ? content.map((c) => c.text ?? "").join("\n") : JSON.stringify(res.result);
      return { ok: res.status === "success", text };
    } catch (e) {
      return { ok: false, text: `proxy refused or failed: ${describeError(e)}` };
    }
  }

  async report(toolName: string, args: Record<string, unknown>, outcome: ToolOutcome, durationMs: number): Promise<void> {
    await this.session.report(toolName, args, outcome.text.slice(0, 4000), { status: outcome.ok ? "success" : "failed", errorMessage: outcome.ok ? undefined : outcome.text.slice(0, 500), durationMs });
  }

  async close(): Promise<void> {
    await this.session.close().catch(() => undefined);
  }
}

// ─── Delegation ──────────────────────────────────────────────────────────────

/** One subtree-bounded child token: authority over exactly one step of the parent plan. */
export interface SubtreeGrant {
  action: string; // bare action name, e.g. edit_video
  toolName: string; // <mcp>__<action>
  subtreePath: string; // JSON pointer into the parent plan, e.g. /steps/[0]
  trustId: string;
  token: IntentTokenType; // parent token + subtreeDelegation envelope (inclusion proof)
  expiresAt: number;
}

export interface DelegatedAuthority {
  delegationId: string; // trustId of the first grant, used as a display handle
  grants: SubtreeGrant[];
  allowedActions: string[];
  expiresAt: number;
  parentTokenId: string;
  parentPlanHash: string;
  grantedBy: RoleName;
  grantedTo: RoleName;
  delegateAgentId: string;
  delegatePublicKey: string;
}

export interface DelegationGrant {
  authority: DelegatedAuthority;
  parent: TokenInfo;
}

/**
 * The owner-side half of delegation.
 *
 * The granting role (Publisher) captures a plan covering everything it could
 * do itself and mints the parent token. For each action it wants to hand over
 * it asks ArmorIQ (/iap/trust/delegate, "Delegate" trust-update) for a
 * subtree-bounded child token: the backend signs a delta binding the delegate's
 * Ed25519 public key to ONE step of the parent plan and returns the Merkle
 * inclusion proof that links that step to the parent plan root. Steps that
 * were not delegated have no proof, so the delegate cannot present them.
 */
export async function grantDelegation(opts: {
  from: RoleName;
  to: RoleName;
  parentToolNames: string[];
  allowedToolNames: string[];
  goal: string;
  validitySeconds: number;
}): Promise<DelegationGrant> {
  const client = clientFor(opts.from);
  const scope = client.forUser(env.armoriq.userEmail).startSession({ mode: env.armoriq.mode, llm: env.llm.model, validitySeconds: Math.max(opts.validitySeconds * 2, 600), trueReanchor: false });
  const parentToken = await scope.startPlan(
    opts.parentToolNames.map((name) => ({ name, args: {} })),
    opts.goal,
  );
  const parentPlan = (parentToken.rawToken?.plan ?? {}) as { steps?: Array<{ action: string; mcp: string }> };
  const steps = parentPlan.steps ?? [];

  // The delegate's keypair. In production the delegate generates this and shares only the public half.
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const delegatePublicKey = spki.subarray(spki.length - 32).toString("hex");

  const grants: SubtreeGrant[] = [];
  for (const toolName of opts.allowedToolNames) {
    const { tool: action } = splitToolName(toolName);
    const idx = steps.findIndex((s) => s.action === action);
    if (idx === -1) throw new DelegationException(`cannot delegate '${action}': it is not a step of the parent plan`);
    const subtreePath = `/steps/[${idx}]`;
    const r = await client.delegateSubtree(parentToken, {
      delegatePublicKey,
      validitySeconds: opts.validitySeconds,
      parentPlan,
      subtreePath,
      planId: parentToken.planId,
      intentReference: parentToken.tokenId,
      targetAgent: env.armoriq.agents[opts.to],
    });
    const payload = ((r.delta as { payload?: Record<string, unknown> })?.payload ?? {}) as { expires_at?: number };
    grants.push({ action, toolName, subtreePath, trustId: r.trustId, token: r.delegatedToken, expiresAt: payload.expires_at ?? parentToken.expiresAt });
  }
  await scope.close().catch(() => undefined);

  return {
    parent: { tokenId: parentToken.tokenId, planHash: parentToken.planHash, planId: parentToken.planId, expiresAt: parentToken.expiresAt, steps: opts.parentToolNames, mode: env.armoriq.mode },
    authority: {
      delegationId: grants[0]?.trustId ?? "none",
      grants,
      allowedActions: grants.map((g) => g.action),
      expiresAt: Math.min(...grants.map((g) => g.expiresAt)),
      parentTokenId: parentToken.tokenId,
      parentPlanHash: parentToken.planHash,
      grantedBy: opts.from,
      grantedTo: opts.to,
      delegateAgentId: env.armoriq.agents[opts.to],
      delegatePublicKey,
    },
  };
}

/**
 * Governor for an agent acting under DELEGATED authority (the freelance editor).
 * It never mints its own token. Every call is checked against the delegated
 * token: expiry, the allowed-action list ArmorIQ bound into the delegation,
 * and the step set the child token actually carries. In proxy mode the
 * ArmorIQ proxy re-verifies all of that cryptographically before forwarding.
 */
export class DelegatedGovernor implements Governor {
  readonly agentId: string;
  private client: ArmorIQClientType;
  private audit: ArmorIQSessionType;

  constructor(readonly role: RoleName, private authority: DelegatedAuthority, private hub: McpHub) {
    this.client = clientFor(role);
    this.agentId = env.armoriq.agents[role];
    this.audit = this.client.forUser(env.armoriq.userEmail).startSession({ mode: env.armoriq.mode, llm: env.llm.model, trueReanchor: false });
  }

  async plan(toolNames: string[], _goal: string): Promise<TokenInfo | null> {
    const a = this.authority;
    return { tokenId: a.parentTokenId, planHash: a.parentPlanHash, planId: a.grants[0]?.token.planId, expiresAt: a.expiresAt, steps: toolNames, mode: `${env.armoriq.mode} (delegated: ${a.grants.map((g) => g.subtreePath).join(", ")})` };
  }

  private grantFor(action: string): SubtreeGrant | undefined {
    return this.authority.grants.find((g) => g.action === action);
  }

  async check(toolName: string, _args: Record<string, unknown>, _opts: CheckOptions = {}): Promise<Decision> {
    const { tool } = splitToolName(toolName);
    const grant = this.grantFor(tool);
    if (!grant) {
      return { action: "block", source: "delegated-scope", reason: `'${tool}' is outside the delegated scope [${this.authority.allowedActions.join(", ")}] granted by ${this.authority.grantedBy}: no subtree proof was issued for it` };
    }
    if (IntentToken.isExpired(grant.token) || grant.expiresAt * 1000 < Date.now()) {
      return { action: "block", source: "delegated-scope", reason: `delegated token for '${tool}' expired` };
    }
    const proof = grant.token.subtreeDelegation?.inclusionProof;
    if (!Array.isArray(proof) || proof.length === 0) {
      return { action: "block", source: "delegated-scope", reason: `delegated token for '${tool}' carries no Merkle inclusion proof` };
    }
    return { action: "allow", source: "delegated-scope", reason: `within delegated scope: subtree ${grant.subtreePath} of plan ${this.authority.parentPlanHash.slice(0, 12)}… (trust ${grant.trustId})` };
  }

  async awaitApproval(): Promise<"approved" | "rejected" | "timeout"> {
    return "rejected";
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const { mcp, tool } = splitToolName(toolName);
    const grant = this.grantFor(tool);
    if (!grant) return { ok: false, text: `no delegated authority for ${tool}` };
    if (env.armoriq.mode === "sdk") return this.hub.call(toolName, args);
    try {
      // The SDK attaches X-CSRG-Subtree-* headers from the token's envelope; the proxy verifies scope confinement.
      const res = await this.client.invoke(mcp, tool, grant.token, args, undefined, env.armoriq.userEmail);
      const content = (res.result as { content?: Array<{ type: string; text?: string }> })?.content;
      const text = Array.isArray(content) ? content.map((c) => c.text ?? "").join("\n") : JSON.stringify(res.result);
      return { ok: res.status === "success", text };
    } catch (e) {
      return { ok: false, text: `proxy refused or failed: ${describeError(e)}` };
    }
  }

  async report(toolName: string, args: Record<string, unknown>, outcome: ToolOutcome, durationMs: number): Promise<void> {
    await this.audit.report(toolName, args, outcome.text.slice(0, 4000), {
      status: outcome.ok ? "success" : "failed",
      errorMessage: outcome.ok ? undefined : outcome.text.slice(0, 500),
      durationMs,
      isDelegated: true,
      delegatedBy: env.armoriq.agents[this.authority.grantedBy],
      delegatedTo: this.authority.delegateAgentId,
    });
  }

  async close(): Promise<void> {
    await this.audit.close().catch(() => undefined);
  }
}
