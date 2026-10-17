import { EventEmitter } from "node:events";
import type { RoleName } from "./env.js";

export type DecisionSource = "armoriq-policy" | "intent-plan" | "delegated-scope" | "armoriq-proxy" | "armoriq-approval";

export type StudioEvent =
  | { type: "run_started"; scenario: string; title: string }
  | { type: "run_finished"; status: "ok" | "error"; summary?: string }
  | { type: "handoff"; from: RoleName; to: RoleName; summary: string }
  | { type: "agent_started"; role: RoleName; agentId: string; goal: string }
  | { type: "agent_finished"; role: RoleName; answer: string }
  | { type: "plan_declared"; role: RoleName; goal: string; steps: Array<{ tool: string; purpose: string }> }
  | { type: "token_minted"; role: RoleName; tokenId: string; planHash: string; planId?: string; expiresAt: number; mode: string; steps: string[] }
  | { type: "delegation_created"; from: RoleName; to: RoleName; delegationId: string; allowedActions: string[]; expiresAt: number; parentTokenId: string }
  | { type: "tool_call"; role: RoleName; tool: string; args: Record<string, unknown> }
  | { type: "decision"; role: RoleName; tool: string; action: "allow" | "block" | "hold"; source: DecisionSource; reason?: string; matchedPolicy?: string; delegationId?: string }
  | { type: "approval"; role: RoleName; tool: string; delegationId?: string; status: "approved" | "rejected" | "timeout" }
  | { type: "tool_result"; role: RoleName; tool: string; ok: boolean; preview: string }
  | { type: "assistant"; role: RoleName; text: string }
  | { type: "owner_message"; role: RoleName; text: string }
  | { type: "awaiting_reply"; role: RoleName }
  | { type: "error"; role?: RoleName; message: string };

export type Envelope = StudioEvent & { runId: string; seq: number; ts: string };

class Bus extends EventEmitter {
  private seq = 0;
  private history: Envelope[] = [];

  emitStudio(runId: string, event: StudioEvent): Envelope {
    const env: Envelope = { ...event, runId, seq: ++this.seq, ts: new Date().toISOString() };
    this.history.push(env);
    if (this.history.length > 2000) this.history.shift();
    this.emit("event", env);
    const tag = `[${runId.slice(0, 6)}]`;
    const role = "role" in event && event.role ? ` ${event.role}` : "";
    const detail =
      event.type === "decision"
        ? ` ${event.tool} → ${event.action.toUpperCase()} (${event.source}${event.reason ? `: ${event.reason}` : ""})`
        : event.type === "tool_call"
          ? ` ${event.tool}`
          : event.type === "error"
            ? ` ${event.message}`
            : "";
    console.log(`${tag}${role} ${event.type}${detail}`);
    return env;
  }

  replay(sinceSeq = 0): Envelope[] {
    return this.history.filter((e) => e.seq > sinceSeq);
  }
}

export const bus = new Bus();
