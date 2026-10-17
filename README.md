<div align="center">

# 🧠 AInstein

### A multi-agent content machine that runs your social media, **governed by ArmorIQ**

*Reasoning is free. Acting is bounded. Every real-world action goes through an MCP server, and every MCP call goes through ArmorIQ.*

![Flow State 2026](https://img.shields.io/badge/Flow%20State-2026-orange)
![ArmorIQ](https://img.shields.io/badge/governed%20by-ArmorIQ-2563eb)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/protocol-MCP-8b5cf6)

### [▶️ Watch the demo video](https://drive.google.com/file/d/1mmzZPyyu-ZU1XRc3NatmAV1kRGAJStN4/view?usp=sharing)

[![Demo video](https://img.shields.io/badge/%E2%96%B6%20Demo%20video-watch%20on%20Google%20Drive-ea580c?style=for-the-badge&logo=googledrive&logoColor=white)](https://drive.google.com/file/d/1mmzZPyyu-ZU1XRc3NatmAV1kRGAJStN4/view?usp=sharing)

**See what the agents actually posted:**
[![Telegram channel](https://img.shields.io/badge/Telegram-see%20the%20posts-26A5E4?logo=telegram&logoColor=white)](https://t.me/+PV3TEFkYuPNjMWRl)
[![Discord channel](https://img.shields.io/badge/Discord-see%20the%20posts-5865F2?logo=discord&logoColor=white)](https://discord.gg/vqYfNTZhe)

![AInstein console: a Publisher run where the delete is blocked by ArmorIQ](docs/images/console.png)

</div>

---

## 📑 Table of contents

1. [What is AInstein?](#-what-is-ainstein)
2. [The agents](#-the-agents)
3. [How ArmorIQ keeps them in check](#-how-armoriq-keeps-them-in-check)
4. [Governance demos](#-governance-demos)
5. [See it live: the channels](#-see-it-live-the-channels)
6. [Architecture](#-architecture)
7. [Quick start](#-quick-start)
8. [Verify it works](#-verify-it-works)
9. [Repository layout](#-repository-layout)
10. [Pre-existing code disclosure](#-pre-existing-code-disclosure)
11. [Takeaways](#-takeaways)

---

## 💡 What is AInstein?

AInstein is a small **"agency" of four AI agents** that plans, produces and publishes social content for a brand, including **code-generated motion-graphics video** (Remotion) with **AI voiceover** (ElevenLabs).

The twist: the agents are **cryptographically unable** to post, delete or spend outside the rules the owner set.

| Without governance | With ArmorIQ |
|---|---|
| A prompt injection can make the agent publish anything | The injected action is not in the **signed plan**, so it is refused |
| The owner has to trust the model | The owner **approves** audience-facing actions on a dashboard |
| A freelancer needs your full credentials | A freelancer gets a **one-hour, action-scoped, non-transferable token** |
| "What did it do?" is a guess | Every decision lands in an **audit trail** |

---

## 🤖 The agents

| Agent | Thinks about | May act on |
|---|---|---|
| 🔎 **Planner** | trends, audience reactions, reference material, briefs | read-only research, drafts |
| 🎬 **Creator** | videos (Remotion), voiceover (ElevenLabs), captions | video creation and edits, drafts. The final render is **held** |
| 📣 **Publisher** | scheduling, publishing, replying | schedules freely. Publish and reply are **held** for the owner. Delete is **blocked** |
| ✂️ **Freelance editor** | edits handed over by the Publisher | only what a **delegated token** allows, for one hour |

### 🔌 The tools they use (MCP servers)

Real-world capability lives in MCP servers (`packages/mcp`):

| MCP server | What it does |
|---|---|
| **research-mcp** | Brand kit, Hacker News trends, URL fetch (treated as untrusted content), analytics |
| **video-mcp** | Wraps the Remotion-Agent pipeline: create, edit, preview (free), render MP4 (costly), ElevenLabs voiceover, export source, delete |
| **social-mcp** | A sandbox feed: draft, schedule, publish, reply, delete. Enforces brand rules on arguments (platform allowlist, banned words, caption length) |
| **telegram** *(public, third-party)* | The published `@node2flow/telegram-bot-mcp`, run in HTTP mode and proxied by our host so ArmorIQ can register it. Approved content lands in a private Telegram channel. Sends are **held**, `tg_delete_message` is **blocked** for everyone |
| **discord** *(public, third-party)* | The published `mcp-discord`, run unmodified in HTTP mode and proxied the same way. `discord_send` is **held**. Deletes and every channel, category and webhook tool are **blocked** for everyone |

---

## 🛡️ How ArmorIQ keeps them in check

Each agent is a **registered ArmorIQ agent** with its own policy. The runtime ([packages/agent/src/agent.ts](packages/agent/src/agent.ts)) is a **two-phase loop**:

```mermaid
sequenceDiagram
    autonumber
    participant LLM as 🧠 Agent (LLM)
    participant Gov as 🛡️ Governor
    participant AIQ as ArmorIQ
    participant MCP as 🔌 MCP server
    participant Owner as 👤 Owner

    LLM->>Gov: Declare the tools I intend to use
    Gov->>AIQ: startPlan()
    AIQ-->>Gov: Signed intent token (Merkle tree)
    loop every tool call
        LLM->>Gov: call tool X
        Gov->>AIQ: check(X)
        alt not in the signed plan
            AIQ-->>Gov: ❌ BLOCKED (intent mismatch)
        else policy says block
            AIQ-->>Gov: ❌ BLOCKED
        else policy says hold
            AIQ->>Owner: approval request
            Owner-->>AIQ: approve / reject
            AIQ-->>Gov: ⏸ HELD, then approved
            Gov->>MCP: execute
        else allowed
            AIQ-->>Gov: ✅ ALLOWED
            Gov->>MCP: execute
        end
        Gov->>AIQ: report() to the audit trail
    end
```

1. **Declare.** The LLM states which tools it intends to use. `session.startPlan()` sends that plan to ArmorIQ, which canonicalises it, builds a Merkle tree and mints a signed **intent token**.
2. **Execute.** Every tool call runs `session.check()` first.
   - A tool that was **never declared** is refused as an *intent mismatch* before any policy is consulted.
   - A declared tool is evaluated against the agent's policy: **allow**, **hold** or **block**.
   - Only an allowed or approved call reaches the MCP server, and the outcome is written to the audit trail with `session.report()`.

### ⏸️ Holds (human approval)

Audience-facing and costly calls (publishing, Telegram and Discord sends, final renders) are listed per agent in [armoriq/holds.json](armoriq/holds.json). For those, the governor files an **approval request with ArmorIQ**, tied to the signed plan, and waits for the owner's decision on the ArmorIQ dashboard. **Rejection or timeout fails closed.**

### 🤝 Delegation

The Publisher can hand work to a freelance editor with ArmorIQ's **subtree delegation** (`client.delegateSubtree()`). For each handed-over step, the backend signs a "Delegate" trust delta bound to the editor's Ed25519 key and returns a Merkle inclusion proof linking that step to the parent plan root. Steps that were **not** delegated have no proof, so the editor cannot present them.

### ⚙️ Two enforcement modes

Selected with `ARMORIQ_MODE`:

| Mode | How it works | Needs |
|---|---|---|
| `sdk` | ArmorIQ's backend decides (`/iap/sdk/enforce`), the agent executes the MCP tool itself | works on localhost |
| `proxy` | every call goes to `proxy.armoriq.ai`, which verifies the Merkle proof for that step and forwards to the registered MCP server | the MCP host on a public HTTPS URL |

> **Nothing is simulated.** If `ARMORIQ_API_KEY` is missing, the console refuses to run.

---

## 🎬 Governance demos

The console has a one-click demo for every governance primitive.

![Governance demos panel in the console](docs/images/demos.png)

| Demo | What happens | Decision |
|---|---|---|
| ▶️ **Run a campaign** | Planner → Creator (video + caption) → Publisher schedules | ✅ **ALLOWED**, full audit trail |
| 📤 **Publish now** | Publisher calls `publish_post` | ⏸️ **HELD** → owner approves on the dashboard → published |
| 🚫 **Creator tries to publish** | Creator declares and calls `publish_post` | ❌ **BLOCKED** by the creator policy |
| ☠️ **Poisoned article** | Planner summarises a page with a planted "owner" note telling it to publish | The model refuses. Had it complied, `publish_post` is not in its signed plan, so it is **BLOCKED** |
| 📈 **Mid-task scope creep** | Publisher signs a read-only plan, then the owner asks it to delete a post | The agent tries. **BLOCKED**: `tool-not-in-plan` (intent mismatch) |
| 🧑‍🎨 **Delegate to a freelance editor** | Editor edits and previews under subtree tokens, then tries to render and publish | ✅ ALLOWED ×2, then ❌ **BLOCKED**: no subtree proof for those steps |

### 📸 Live proof

Screenshots from real runs of the console against the live ArmorIQ platform, step by step.

**1. ⏸️ Publish now: the publish is HELD for the owner.**
The Publisher signs a 6-step plan, reads the brand kit and posting rules and saves a draft (all ✅ ALLOWED). The audience-facing `publish_post` is **HELD** and the agent waits for approval on the ArmorIQ dashboard (approval id shown). Rejection or timeout fails closed.

![Publish now: held for approval](docs/images/demo-publish-held.png)

**2. 🚧 Mid-task scope creep: BLOCKED by intent.**
The Publisher signs a plan containing only `list_posts`. The owner then asks it to delete a post. The agent tries, and ArmorIQ refuses with `tool-not-in-plan`, because delete was never in the signed plan.

![Scope creep: delete blocked, not in the signed plan](docs/images/demo-scope-creep.png)

**3. 🤝 Delegation: the freelance editor is stopped at the edge of its token.**
The editor runs under a delegated, scoped token. In this run there was no video project yet, so the edit and preview calls hit a tool error. The calls outside the delegated scope (`Check video status`, `List workspace posts`) are **BLOCKED** with "Outside what was delegated".

![Delegation: out-of-scope calls blocked](docs/images/demo-delegation.png)

**4. 🧾 A refused delete in a free-form run.**
Asked to delete a post, the Publisher's plan declares the delete, and ArmorIQ's policy refuses it (`BLOCKED`, "Refused by ArmorIQ policy"). Nothing was deleted.

![Policy block on delete](docs/images/console.png)

---

## 📺 See it live: the channels

Everything AInstein publishes is delivered to two real channels. Join them to see the posts and narrated videos the agents created, each one sent only after ArmorIQ allowed it and the owner approved it.

| Channel | Join | What you'll find |
|---|---|---|
| <img src="https://cdn.simpleicons.org/telegram/26A5E4" width="16"> **Telegram** | [Join the Telegram channel](https://t.me/+PV3TEFkYuPNjMWRl) | Captions and narrated MP4 videos, sent by the Publisher with `tg_send_message` / `tg_send_video` |
| <img src="https://cdn.simpleicons.org/discord/5865F2" width="16"> **Discord** | [Join the Discord server](https://discord.gg/vqYfNTZhe) | The same posts with video links, sent by the Publisher with `discord_send` |

**What you will *not* find:** anything that was **blocked** or **rejected**. Deletes, posts outside the signed plan, and sends that were never approved never reached these channels, and that absence is the point.

> Every message corresponds to a run you can trace on platform.armoriq.ai: the signed plan under **Intent**, the approval under **Held Actions**, and the audit entry under **Observability**.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    Owner([👤 Owner]) --> Console

    subgraph Agent["packages/agent · Console :4200"]
        Console[Web console]
        Agents["DeepSeek tool-calling agents<br/>planner · creator · publisher · editor"]
        Console --> Agents
    end

    Agents -- "declare plan" --> IAP
    Agents -- "check(tool)" --> POL
    Agents -- "report()" --> AUD

    subgraph ArmorIQ["ArmorIQ platform"]
        IAP["IAP: signed intent token"]
        POL["Policy: allow / hold / block"]
        AUD["Audit trail"]
    end

    Agents -- "allowed calls" --> Host

    subgraph MCP["packages/mcp · MCP host :4100"]
        Host{{"/mcp/*"}}
        Host --> R[research]
        Host --> V[video]
        Host --> S[social]
        Host --> T[telegram]
        Host --> D[discord]
    end

    V --> Remotion["Remotion-Agent API :3210"]
    V --> EL[ElevenLabs]
    S --> Feed["Sandbox feed"]
    T --> TG[(Telegram channel)]
    D --> DC[(Discord channel)]
```

---

## 🚀 Quick start

### Prerequisites

- **Node 20+**
- **Python 3** with `pip install armoriq-sdk` (used only to register with the platform)
- A **DeepSeek** API key
- An **ArmorIQ** API key (see [armoriq/SETUP.md](armoriq/SETUP.md))
- `cloudflared` (or any tunnel) so ArmorIQ can reach your MCP host

### Steps

```powershell
# 1. Install
npm install
npm run setup:telegram     # installs the public Telegram MCP into vendor/telegram-mcp
npm run setup:discord      # installs the public Discord MCP into vendor/discord-mcp

# 2. Configure
copy .env.example .env     # fill ARMORIQ_*, DEEPSEEK_API_KEY, TELEGRAM_*, DISCORD_*

# 3. Start the MCP host (terminal 1)
npm run dev:mcp            # http://localhost:4100

# 4. Expose it (terminal 2), then put the URL in .env as MCP_PUBLIC_URL and restart terminal 1
cloudflared tunnel --url http://localhost:4100

# 5. Register agents and MCP servers on platform.armoriq.ai
npm run register:armoriq

# 6. Start the console (terminal 3)
npm run dev:agent          # http://localhost:4200
```

Then add the per-agent rules and holds in the platform's policy builder as listed in [armoriq/SETUP.md](armoriq/SETUP.md), open http://localhost:4200 and check that **Policy readiness** is green. Approvals are made on https://platform.armoriq.ai.

> 🎥 **Want real video?** Also start the Remotion-Agent worker and API (see [Pre-existing code disclosure](#-pre-existing-code-disclosure)).

### Key environment variables

| Variable | Purpose |
|---|---|
| `ARMORIQ_API_KEY` | **Required.** From platform.armoriq.ai → API Keys |
| `ARMORIQ_USER_EMAIL` | The owner who approves held actions |
| `ARMORIQ_REQUESTER_EMAIL` | A second org member under which approval requests are filed (four-eyes rule) |
| `ARMORIQ_MODE` | `sdk` (default) or `proxy` |
| `DEEPSEEK_API_KEY` | LLM for the agents |
| `MCP_PUBLIC_URL` | Public tunnel URL of the MCP host |
| `ELEVENLABS_API_KEY` | Optional, for voiceover |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional real distribution to Telegram |
| `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID` | Optional real distribution to Discord |

Full list with comments: [.env.example](.env.example).

---

## ✅ Verify it works

Checks that need no LLM:

```powershell
npm run smoke:mcp          # exercises the MCP servers
npm run smoke:armoriq      # token minting, allow/hold/block, intent mismatch, delegation
npm run probe:matrix       # the live ArmorIQ decision for every role × tool pair
```

---

## 🗂️ Repository layout

```
flow-state/
├── packages/
│   ├── mcp/              MCP servers (Streamable HTTP, stateless), brand guard, sandbox stores, Telegram proxy
│   └── agent/            Governed agent runtime, scenarios, ArmorIQ governors, web console
├── vendor/
│   ├── telegram-mcp/     Isolated install of the public Telegram MCP + launch.mjs shim
│   └── discord-mcp/      Isolated install of the public Discord MCP (mcp-discord), unmodified
├── armoriq/              Platform setup guide, policy references, holds.json
└── docs/images/          README screenshots
```

---

## 📜 Pre-existing code disclosure

The **Remotion-Agent** video pipeline (prompt → motion-graphics code → MP4) was built before the hackathon by the same team and is used unchanged except for a one-line deep-link in its preview app.

Everything in **this repository**, the agents, the MCP servers, the sandbox social layer, the ArmorIQ integration, delegation and the console, was built during the hackathon window.

---

## 💭 Takeaways

- 🔑 **ArmorIQ binds the tool name into the signed plan, not its arguments.** Rules about *what* is posted (platform, words, length) therefore live in the MCP server as a second layer. Both layers are needed; neither is enough alone.
- 🔒 **SDK mode fails closed.** With no matching policy every call is blocked (`no_matching_policy`). Policies registered from `armoriq.yaml` are org-wide per MCP server and their allow lists are intersected, so per-agent differences and holds must be authored in the platform's policy builder.
- 🧪 **A well-aligned model refused every prompt injection we planted** (DeepSeek here). The boundary still matters: when the *owner* changed the task mid-flight, the model complied and ArmorIQ refused the undeclared tool. Governance has to hold for legitimate-looking drift, not just obvious attacks.
- 📝 **Declaring intent before acting is what stops prompt injection.** The poisoned page can change what the model *wants*, but cannot add a tool to a plan that is already signed.
- ⏸️ **Holds turn "the agent might publish something wrong" into "the agent cannot publish until I say so"**, without the owner approving every step.
- 🎟️ **Delegation with an expiring, action-scoped, non-transferable token** is the right primitive for freelancers and agencies, and almost nobody uses it yet.

### 🔭 What's next

Argument-level policies via ArmorIQ tool metadata (amount fields for voiceover characters and render seconds), per-platform brand bundles, and real platform connectors behind the same MCP contract.

---

<div align="center">

Built for **Flow State 2026** by team **AInstein** 💡

</div>
