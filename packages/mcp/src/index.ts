import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dataDir, env, repoRoot, runtimeDir } from "./env.js";
import { buildResearchServer } from "./servers/research.js";
import { buildSocialServer, socialStore } from "./servers/social.js";
import { buildVideoServer, mixedFilePath, videoLibrary } from "./servers/video.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/**
 * One stateless Streamable-HTTP MCP endpoint per server. A fresh McpServer +
 * transport per request keeps the host trivially deployable (no session
 * affinity) which is what the ArmorIQ proxy and scanner expect.
 */
function mountMcp(route: string, build: () => McpServer) {
  app.post(route, async (req: Request, res: Response) => {
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error(`[mcp:${route}]`, e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  });
  const reject = (_req: Request, res: Response) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Stateless server: POST only." }, id: null });
  app.get(route, reject);
  app.delete(route, reject);
}

mountMcp("/mcp/research", buildResearchServer);
mountMcp("/mcp/video", buildVideoServer);
mountMcp("/mcp/social", buildSocialServer);

/**
 * Public, third-party MCP server: @node2flow/telegram-bot-mcp.
 * We do not write Telegram code; we run the published package in its
 * Streamable-HTTP mode as a child process and reverse-proxy it under the same
 * public URL so the ArmorIQ platform can register and scan it like the others.
 * The server is session-based, so the mcp-session-id header is forwarded both ways.
 */
function mountPublicMcp(opts: { name: string; bin: string; args: string[]; childEnv: Record<string, string>; port: number; installCheck: string; setupScript: string; label: string }) {
  if (!fs.existsSync(opts.installCheck)) {
    console.error(`  ${opts.name} → NOT STARTED: vendor install missing. Run: ${opts.setupScript}`);
    return;
  }
  const child = spawn(process.execPath, [opts.bin, ...opts.args], {
    env: { ...process.env, ...opts.childEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${opts.name}-mcp] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${opts.name}-mcp] ${d}`));
  child.on("exit", (code) => console.error(`[${opts.name}-mcp] exited with code ${code}`));
  process.on("exit", () => child.kill());

  const upstream = `http://127.0.0.1:${opts.port}/mcp`;
  const forward = async (req: Request, res: Response) => {
    const headers: Record<string, string> = {};
    for (const h of ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    try {
      const r = await fetch(upstream, {
        method: req.method,
        headers,
        body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
        // @ts-expect-error Node fetch option for streaming request bodies
        duplex: "half",
      });
      res.status(r.status);
      for (const h of ["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control"]) {
        const v = r.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      if (!r.body) return res.end();
      Readable.fromWeb(r.body as never).pipe(res);
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ jsonrpc: "2.0", error: { code: -32001, message: `${opts.name} MCP unreachable: ${(e as Error).message}` }, id: null });
    }
  };
  app.post(`/mcp/${opts.name}`, forward);
  app.get(`/mcp/${opts.name}`, forward);
  app.delete(`/mcp/${opts.name}`, forward);
  console.log(`  ${opts.name.padEnd(8)} → ${env.publicUrl}/mcp/${opts.name}  (proxy for ${opts.label} on :${opts.port})`);
}

if (env.telegramBotToken) {
  // Installed in isolation (vendor/telegram-mcp); launch.mjs adapts the package's JSON-Schema tool
  // definitions to the current MCP SDK without modifying the package itself.
  mountPublicMcp({
    name: "telegram",
    label: "@node2flow/telegram-bot-mcp",
    bin: path.join(repoRoot, "vendor", "telegram-mcp", "launch.mjs"),
    args: ["--http"],
    childEnv: { TELEGRAM_BOT_TOKEN: env.telegramBotToken, PORT: String(env.telegramMcpPort) },
    port: env.telegramMcpPort,
    installCheck: path.join(repoRoot, "vendor", "telegram-mcp", "node_modules", "@node2flow", "telegram-bot-mcp"),
    setupScript: "npm run setup:telegram",
  });
} else {
  console.log("  telegram → disabled (TELEGRAM_BOT_TOKEN not set)");
}

if (env.discordBotToken) {
  // Public mcp-discord (barryyip0625), unmodified, in its native HTTP mode.
  mountPublicMcp({
    name: "discord",
    label: "mcp-discord",
    bin: path.join(repoRoot, "vendor", "discord-mcp", "node_modules", "mcp-discord", "build", "index.js"),
    args: ["--transport", "http", "--port", String(env.discordMcpPort)],
    childEnv: { DISCORD_TOKEN: env.discordBotToken },
    port: env.discordMcpPort,
    installCheck: path.join(repoRoot, "vendor", "discord-mcp", "node_modules", "mcp-discord"),
    setupScript: "npm run setup:discord",
  });
} else {
  console.log("  discord  → disabled (DISCORD_BOT_TOKEN not set)");
}

// ── Human-facing helpers (used by the agent console) ─────────────────────────
app.get("/", (_req, res) => {
  res.json({
    name: "AInstein MCP host",
    servers: {
      research: `${env.publicUrl}/mcp/research`,
      video: `${env.publicUrl}/mcp/video`,
      social: `${env.publicUrl}/mcp/social`,
      ...(env.telegramBotToken ? { telegram: `${env.publicUrl}/mcp/telegram` } : {}),
      ...(env.discordBotToken ? { discord: `${env.publicUrl}/mcp/discord` } : {}),
    },
    demoArticle: `${env.publicUrl}/demo/competitor-article`,
    feed: `${env.publicUrl}/feed`,
  });
});
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/feed", (_req, res) => res.json(socialStore.all().filter((p) => p.status !== "deleted")));
app.get("/library", (_req, res) => res.json(videoLibrary.all()));
app.post("/admin/reset", (_req, res) => {
  socialStore.reset();
  res.json({ ok: true });
});
app.get("/demo/competitor-article", (_req, res) => {
  res.type("html").send(fs.readFileSync(path.join(dataDir, "demo", "competitor-article.html"), "utf8"));
});
app.use("/media/voiceovers", express.static(path.join(runtimeDir, "voiceovers")));

/** Public pass-through for rendered MP4s so Telegram (and judges) can fetch them via the tunnel. Supports Range so <video> can seek. */
app.get("/media/renders/:versionId-vo.mp4", (req, res) => {
  const { versionId } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(versionId)) return res.status(400).json({ error: "bad id" });
  const file = mixedFilePath(versionId);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "no mixed render for this version" });
  res.type("video/mp4").sendFile(file);
});
app.get("/media/renders/:versionId.mp4", async (req, res) => {
  const { versionId } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(versionId)) return res.status(400).json({ error: "bad id" });
  try {
    const headers: Record<string, string> = {};
    if (typeof req.headers.range === "string") headers.range = req.headers.range;
    const r = await fetch(`${env.remotionApiUrl}/api/renders/${versionId}`, { headers });
    res.status(r.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!r.body) return res.end();
    Readable.fromWeb(r.body as never).pipe(res);
  } catch (e) {
    res.status(502).json({ error: `Remotion API unreachable: ${(e as Error).message}` });
  }
});

app.listen(env.port, "0.0.0.0", () => {
  console.log(`MCP host listening on http://0.0.0.0:${env.port}`);
  console.log(`  research → ${env.publicUrl}/mcp/research`);
  console.log(`  video    → ${env.publicUrl}/mcp/video   (Remotion API: ${env.remotionApiUrl})`);
  console.log(`  social   → ${env.publicUrl}/mcp/social  (Discord webhook: ${env.discordWebhookUrl ? "on" : "off"})`);
});
