# AInstein — a multi-agent content machine that runs your social media, governed by ArmorIQ

**Flow State 2026 (ArmorIQ) submission.** Agents plan, produce and publish social
content, including code-generated motion-graphics video, and are cryptographically
unable to post, delete or spend outside the rules the owner set.

> Reasoning is free. Acting is bounded. Every real-world action goes through an
> MCP server, and every MCP call goes through ArmorIQ.

## What it does

A small "agency" of four agents runs a brand's social presence:

| Agent | Thinks about | May act on |
|---|---|---|
| **Planner** | trends, audience reactions, reference material, briefs | read-only research, drafts |
| **Creator** | videos (Remotion), voiceover (ElevenLabs), captions | video creation and edits, drafts; final render is **held** |
| **Publisher** | scheduling, publishing, replying | schedule freely; publish and reply are **held** for the owner; delete is **blocked** |
| **Freelance editor** | edits handed to it by the Publisher | only what a **delegated token** allows, for one hour |

Real-world capability lives in three MCP servers (`packages/mcp`):

- **research-mcp**: brand kit, Hacker News trends, URL fetch (untrusted content), analytics.
- **video-mcp**: wraps the pre-existing Remotion-Agent pipeline: create, edit, preview (free), render MP4 (costly), ElevenLabs voiceover, export source, delete.
- **social-mcp**: a sandbox feed: draft, schedule, publish, reply, delete. Enforces brand rules on arguments (platform allowlist, banned words, caption length).
- **telegram** (public, third-party): the published `@node2flow/telegram-bot-mcp` server, run in its HTTP mode and proxied by our host so ArmorIQ can register it. Approved content really goes here: a private Telegram channel the owner watches on their phone. Sends are held for approval; `tg_delete_message` is blocked for everyone.
- **discord** (public, third-party): the published `mcp-discord` server, run unmodified in its HTTP mode and proxied the same way, posting into a test Discord server. `discord_send` is held for approval; deletes and every channel, category and webhook management tool are blocked for everyone.

## How ArmorIQ is used

Each agent is a registered ArmorIQ agent with its own policy. The agent runtime (`packages/agent/src/agent.ts`) is a two-phase loop:

1. **Declare.** The LLM states which tools it intends to use for the goal. `session.startPlan()` sends that plan to ArmorIQ, which canonicalises it, builds the Merkle tree and mints a signed **intent token**.
2. **Execute.** Every tool call runs `session.check()` first. A tool that was never declared is refused as an **intent mismatch** before any policy is consulted. A declared tool is evaluated against the agent's policy on the platform: **allow**, **hold** (an approval request appears on the ArmorIQ dashboard and the agent waits), or **block**. Only an allowed or approved call reaches the MCP server, and the outcome is written to the audit trail with `session.report()`.

Holds: audience-facing and costly calls (publishing, Telegram and Discord sends,
final renders) are listed per agent in `armoriq/holds.json`. For those the
governor files an approval request with ArmorIQ, tied to the signed plan, and
waits for the owner's decision on the ArmorIQ dashboard. Rejection or timeout
fails closed. A platform policy that returns `hold` takes precedence.

Delegation uses `client.delegate()`: the Publisher mints a parent token covering edit, preview, render and publish, then asks ArmorIQ for a child token bound to the editor's Ed25519 key, restricted to `edit_video` and `preview_video`, valid for one hour and non-transferable. The editor's governor refuses anything outside that scope.

Two enforcement modes, selected with `ARMORIQ_MODE`:

- `sdk`: ArmorIQ's backend decides (`/iap/sdk/enforce`), the agent executes the MCP tool itself. Works on localhost.
- `proxy`: every call is sent to `proxy.armoriq.ai`, which verifies the Merkle inclusion proof for that step and forwards to the MCP server registered on the platform. Needs the MCP host on a public HTTPS URL.

Nothing is simulated. If `ARMORIQ_API_KEY` is missing the console refuses to run.

## The demo beats

| Button | What happens | Decision |
|---|---|---|
| Run a campaign | Planner → Creator (video + caption) → Publisher schedules | ALLOWED, full audit trail |
| Publish now | Publisher calls `publish_post` | HELD → owner approves on dashboard → published |
| Creator tries to publish | Creator declares and calls `publish_post` | BLOCKED by the creator policy |
| Poisoned article | Planner summarises a page with a planted "owner" note telling it to publish | The model refuses; if it had complied, `publish_post` is not in its signed plan and is refused |
| Mid-task scope creep | Publisher signs a read-only plan, then the owner asks it to delete a post | The agent tries; BLOCKED: `tool-not-in-plan` (intent mismatch) |
| Delegate to a freelance editor | Editor edits and previews under subtree tokens, then tries to render and publish | ALLOWED ×2, then BLOCKED: no subtree proof for those steps |

Delegation uses ArmorIQ's subtree delegation (`client.delegateSubtree()`): for each
handed-over step the backend signs a "Delegate" trust delta bound to the
editor's Ed25519 key and returns the Merkle inclusion proof linking that step to
the parent plan root. Steps that were not delegated have no proof, so the editor
cannot present them.

## Architecture

```
 Owner ──▶ Console (packages/agent, :4200)
             │  DeepSeek tool-calling agents: planner · creator · publisher · editor(delegated)
             │
             │  declare plan ──▶ ArmorIQ IAP: signed intent token
             │  check(tool)  ──▶ ArmorIQ policy: allow / hold / block
             │  report()     ──▶ ArmorIQ audit trail
             ▼
      MCP host (packages/mcp, :4100)
        /mcp/research   /mcp/video ──▶ Remotion-Agent API (:3210) + ElevenLabs
                        /mcp/social ──▶ sandbox feed (+ Discord webhook)
```

## Run it

Prerequisites: Node 20+, Python 3 (`pip install armoriq-sdk`, used only to register with the platform), a DeepSeek API key, an ArmorIQ API key.

```powershell
npm install
npm run setup:telegram               # installs the public Telegram MCP into vendor/telegram-mcp
npm run setup:discord                # installs the public Discord MCP into vendor/discord-mcp
copy .env.example .env               # fill ARMORIQ_*, DEEPSEEK_API_KEY, TELEGRAM_BOT_TOKEN/CHAT_ID, DISCORD_BOT_TOKEN/CHANNEL_ID

npm run dev:mcp                      # terminal 1: MCP host on :4100
cloudflared tunnel --url http://localhost:4100   # terminal 2: public URL → MCP_PUBLIC_URL in .env, restart terminal 1
npm run register:armoriq             # registers 4 agents + 3 MCP servers on platform.armoriq.ai
npm run dev:agent                    # terminal 3: console on :4200

# optional, for real video, in the Remotion-Agent repo:
#   npm run start -w @mograph/worker ; npm run start -w @mograph/api ; npm run dev -w @mograph/web
```

Then add the per-agent rules and holds in the platform's policy builder as listed in
[armoriq/SETUP.md](armoriq/SETUP.md), open http://localhost:4200 and check that
*Policy readiness* is green. Approvals are made on https://platform.armoriq.ai.

Checks without an LLM:

```powershell
npm run smoke:mcp            # exercises the three MCP servers
npm run smoke:armoriq        # token minting, allow/hold/block, intent mismatch, delegation
npm run probe:matrix         # the live ArmorIQ decision for every role × tool pair
```

## Repository layout

```
packages/mcp         three MCP servers (Streamable HTTP, stateless) + brand guard + sandbox stores + Telegram proxy
packages/agent       governed agent runtime, scenarios, ArmorIQ governors, web console
vendor/telegram-mcp  isolated install of the public Telegram MCP + launch.mjs (adapts its JSON-Schema tools to the current MCP SDK)
vendor/discord-mcp   isolated install of the public Discord MCP (mcp-discord), used unmodified
armoriq/             platform setup guide and policy references
```

## Pre-existing code disclosure

The Remotion-Agent video pipeline (prompt → motion-graphics code → MP4) was built
before the hackathon by the same team and is used unchanged except for a one-line
deep-link in its preview app. Everything in this repository, the agents, the three
MCP servers, the sandbox social layer, the ArmorIQ integration, delegation and the
console, was built during the hackathon window.

## Takeaways

- ArmorIQ binds the **tool name** into the signed plan, not its arguments. Rules about *what* is posted (platform, words, length) therefore live in the MCP server as a second layer. Both layers are needed; neither is enough alone.
- In SDK mode the backend **fails closed**: with no matching policy every call is blocked (`no_matching_policy`). Policies registered from `armoriq.yaml` are org-wide per MCP server and their allow lists are intersected, so per-agent differences and holds must be authored in the platform's policy builder.
- A well-aligned model (DeepSeek here) refused every prompt injection we planted. The boundary still matters: when the *owner* changed the task mid-flight, the model complied and ArmorIQ refused the undeclared tool. Governance has to hold for legitimate-looking drift, not just obvious attacks.
- Declaring intent before acting is what stops prompt injection: the poisoned page can change what the model *wants*, but cannot add a tool to a plan that is already signed.
- Holds turn "the agent might publish something wrong" into "the agent cannot publish until I say so", without the owner approving every step.
- Delegation with an expiring, action-scoped, non-transferable token is the right primitive for freelancers and agencies, and almost nobody uses it yet.

Next: argument-level policies via ArmorIQ tool metadata (amount fields for voiceover characters and render seconds), per-platform brand bundles, and real platform connectors behind the same MCP contract.
