import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./env.js";

export interface BrandKit {
  name: string;
  tagline: string;
  voice: string;
  approvedPlatforms: string[];
  requiredHashtags: string[];
  bannedWords: string[];
  maxCaptionLength: number;
  maxVoiceoverCharacters: number;
  colors: Record<string, string>;
  audience: string;
}

let cached: BrandKit | null = null;

export function loadBrandKit(): BrandKit {
  if (cached) return cached;
  const file = path.join(dataDir, "brand.json");
  cached = JSON.parse(fs.readFileSync(file, "utf8")) as BrandKit;
  return cached;
}

export interface GuardResult {
  ok: boolean;
  violations: string[];
}

/**
 * Layer-2 enforcement that lives INSIDE the MCP server.
 *
 * ArmorIQ decides WHICH tools an agent may call (allow / hold / block, per
 * agent, per MCP). Intent tokens bind the tool NAME, not its arguments, so
 * content rules that depend on arguments (platform allowlist, banned words,
 * length caps) are enforced here, at the execution boundary, where the agent
 * cannot reach around them.
 */
export function guardCaption(caption: string, platform: string): GuardResult {
  const kit = loadBrandKit();
  const violations: string[] = [];
  const p = platform.toLowerCase();
  if (!kit.approvedPlatforms.includes(p)) {
    violations.push(`platform '${platform}' is not in the approved list [${kit.approvedPlatforms.join(", ")}]`);
  }
  if (caption.length > kit.maxCaptionLength) {
    violations.push(`caption is ${caption.length} chars; limit is ${kit.maxCaptionLength}`);
  }
  const lower = caption.toLowerCase();
  for (const w of kit.bannedWords) {
    if (lower.includes(w.toLowerCase())) violations.push(`caption contains banned word '${w}'`);
  }
  return { ok: violations.length === 0, violations };
}
