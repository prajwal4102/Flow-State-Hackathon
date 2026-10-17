# ArmorIQ platform setup

Everything the agents do is attributed to identities and policies on the
ArmorIQ platform. Names must match the `.env` values **exactly**; a mismatched
agent name means the policy silently never fires.

## 1. Accounts and keys

1. Every team member: sign up at https://tools.armoriq.ai, pick **Pro**, apply code `FLOWSTATEPRO`.
2. Sign in to https://platform.armoriq.ai → **API Keys → Create key**. Paste it into `.env` as `ARMORIQ_API_KEY` (starts with `ak_live_`).
3. Set `ARMORIQ_USER_EMAIL` to the owner who will approve held actions.

## 2. Expose the MCP host

The platform must be able to reach the MCP servers to register and scan them.

```powershell
npm run dev:mcp                                           # terminal 1, port 4100
cloudflared tunnel --url http://localhost:4100            # terminal 2 (winget install Cloudflare.cloudflared)
```

Copy the `https://….trycloudflare.com` URL into `.env` as `MCP_PUBLIC_URL`, then
restart the MCP host so tool results carry the public URL. For the judged live
demo use a stable deployment or a named tunnel; quick tunnels change URL on
every restart, and a URL change means re-registering (step 3).

## 3. Register agents and MCP servers (scripted, no dashboard needed)

The TypeScript CLI does not implement `register` yet, so this uses the Python SDK:

```powershell
pip install armoriq-sdk
npm run register:armoriq
```

The script writes one `armoriq/register/<agent>.yaml` per agent and pushes it to
`POST /iap/sdk/register` with your API key. After it finishes, the platform shows
four agents (`studio-planner`, `studio-creator`, `studio-publisher`,
`studio-editor`) and the MCP servers (`research`, `video`, `social`, and
`telegram` when `TELEGRAM_BOT_TOKEN` is set) with their tools discovered.

**Telegram (public MCP).** Run `npm run setup:telegram` once; it installs the
third-party `@node2flow/telegram-bot-mcp` package in `vendor/telegram-mcp`. The
MCP host spawns it in HTTP mode and proxies it at `/mcp/telegram`, so it shares
the public URL. Set `TELEGRAM_BOT_TOKEN` (BotFather) and `TELEGRAM_CHAT_ID`
(your private test channel) in `.env`.

**Discord (public MCP).** Run `npm run setup:discord` once; it installs the
third-party `mcp-discord` package in `vendor/discord-mcp`, unmodified. The host
spawns it with `--transport http` and proxies it at `/mcp/discord`. Set
`DISCORD_BOT_TOKEN` (developer portal, with Message Content, Server Members and
Presence intents) and `DISCORD_CHANNEL_ID` (a channel in a test server the bot
was invited to). The bot takes 10 to 20 seconds to log in after the host starts.

**What the yaml `policy` block does, as observed:** the control plane turns it
into one policy per MCP server named `cli-<agent>-<mcp>` and, when evaluating a
call, intersects the allow lists of every registration for that server. These
policies are org-wide, not per agent. The script therefore writes one uniform
baseline: every productive tool allowed, `delete_post`, `delete_project` and
`export_source` denied for everyone. Per-agent differences come from step 4.

Verify with:

```powershell
npm run smoke:armoriq     # PASS/FAIL per primitive
npm run probe:matrix      # the live decision for every role × tool pair
```

## 4. Per-agent rules and holds (Platform → Policies)

Create these in the platform's policy builder, bound to the named agent. They
are what make the "Creator tries to publish" and "Publish now" beats work.

| Policy name | Agent | Tools | Action |
|---|---|---|---|
| `pol-creator-deny-publish` | `studio-creator` | `publish_post`, `schedule_post`, `reply_comment` | **block** |
| `pol-creator-render-approval` | `studio-creator` | `render_final` | **hold / require approval** |
| `pol-planner-read-only` | `studio-planner` | `publish_post`, `schedule_post`, `reply_comment`, `create_video`, `edit_video`, `render_final`, `generate_voiceover` | **block** |
| `pol-publisher-audience-approval` | `studio-publisher` | `publish_post`, `reply_comment` | **hold / require approval** |
| `pol-publisher-no-production` | `studio-publisher` | `create_video`, `generate_voiceover` | **block** |
| `pol-editor-no-standing-rights` | `studio-editor` | everything except `edit_video`, `preview_video` | **block** |
| `pol-telegram-publisher-approval` | `studio-publisher` | `tg_send_message`, `tg_send_photo`, `tg_send_video` (public Telegram MCP) | **hold / require approval** |
| `pol-telegram-no-one-else` | `studio-planner`, `studio-creator`, `studio-editor` | `tg_send_message`, `tg_send_photo`, `tg_send_video` | **block** |

| `pol-discord-publisher-approval` | `studio-publisher` | `discord_send` (public Discord MCP) | **hold / require approval** |
| `pol-discord-no-one-else` | `studio-planner`, `studio-creator`, `studio-editor` | `discord_send` | **block** |

`tg_delete_message`, `tg_edit_message_text`, `discord_delete_message` and every
Discord channel, category and webhook management tool are already denied for
everyone by the baseline.

The intent of each policy is also written out in `armoriq/policies/*.yaml`.
After saving, open the console (http://localhost:4200) and press **Re-check**
under *Policy readiness*. All five rows must be green:

- Run a campaign: creator `create_video` → allow, publisher `schedule_post` → allow
- Publish now: publisher `publish_post` → **hold**
- Creator tries to publish: creator `publish_post` → **block**
- Poisoned article: planner `delete_post` → block

## 5. Holds and approvals

Two things can put a call on hold:

1. A platform policy that returns `hold` (authored in the dashboard, step 4).
2. The owner's hold rules in `armoriq/holds.json`. For each listed tool the
   governor files an **approval request with ArmorIQ** (the same delegation
   request the SDK files for a policy hold), carrying the plan id, token id and
   Merkle root of the signed plan, and then polls ArmorIQ for the decision.

Either way the agent waits up to `ARMORIQ_HOLD_TIMEOUT_SECONDS` (default 900)
and executes only when ArmorIQ reports `approved`. Approve or reject under
**Activity → Held Actions**; the console shows the approval id. Rejection and
timeout both fail closed.

Two platform rules to know:

- **Four eyes.** The member who filed a request cannot approve it. Requests are
  filed under `ARMORIQ_REQUESTER_EMAIL` (a second org member, the "operator");
  the owner in `ARMORIQ_USER_EMAIL` approves. Leave the requester empty and the
  owner's own requests become unapprovable.
- **Approval is per signed plan.** Held Actions shows one row per plan and
  labels it by the plan's first step. Once the owner approves that row, the
  remaining held steps of the same plan proceed on that approval; a new plan
  (new agent run) needs a new approval.

The registration route (`/iap/sdk/register`) stores only allow and deny lists;
`hold` keys in that payload are accepted but ignored, which is why the owner
rules exist. Dashboard policies that return `hold` take precedence automatically.

## 6. Proof for the submission

- Agents and MCP servers in the registry, with scan reports.
- Each per-agent policy.
- Observability / audit entries for a blocked call, a held-then-approved call and a delegated call (`is_delegated`, `delegated_by`, `delegated_to`).
- The console's activity stream with `BLOCKED`, `HELD`, `approved`, `intent-plan` and `delegated-scope` decisions.
