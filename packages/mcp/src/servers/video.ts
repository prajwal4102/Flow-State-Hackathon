import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadBrandKit } from "../brand.js";
import { env, runtimeDir } from "../env.js";
import { JsonStore, shortId } from "../store.js";

/**
 * video-mcp — wraps the pre-existing Remotion-Agent service (apps/api).
 *
 * Remotion-Agent turns a prompt into motion-graphics code, previews it in the
 * browser for free and renders MP4s in a worker. This MCP exposes that
 * pipeline as tools so an agent can create and edit videos, while ArmorIQ
 * decides which agent may render (costly) or delete (destructive).
 */

interface LibraryEntry {
  id: string; // remotion projectId
  title: string;
  prompt: string;
  createdBy: string;
  createdAt: string;
  deleted: boolean;
}

export const videoLibrary = new JsonStore<LibraryEntry>("video-library");

interface RemotionProject {
  project: { id: string; prompt: string; current_version_id: string | null };
  versions: Array<{ id: string; n: number; created_at: number }>;
  genJobs: Array<{ id: string; kind: string; status: string; error: string | null; result_version_id: string | null }>;
  renderJobs: Array<{ id: string; version_id: string; status: string; output_url: string | null; error: string | null }>;
}

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function remotion<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.remotionApiUrl}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Remotion API ${method} ${route} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function previewUrl(projectId: string) {
  return `${env.remotionWebUrl}/?project=${projectId}`;
}

const mixedDir = path.join(runtimeDir, "mixed");
fs.mkdirSync(mixedDir, { recursive: true });

/**
 * Mix a voiceover MP3 into a rendered MP4 with ffmpeg. The video track is copied
 * untouched; audio is encoded to AAC. The result is served at
 * /media/renders/<versionId>-vo.mp4 next to the silent original.
 */
async function mixVoiceover(versionId: string, voiceoverId: string): Promise<string> {
  const mp3 = path.join(runtimeDir, "voiceovers", `${voiceoverId}.mp3`);
  if (!fs.existsSync(mp3)) throw new Error(`voiceover ${voiceoverId} not found`);
  const res = await fetch(`${env.remotionApiUrl}/api/renders/${versionId}`);
  if (!res.ok) throw new Error(`rendered MP4 for version ${versionId} is not available yet (${res.status})`);
  const src = path.join(mixedDir, `${versionId}.src.mp4`);
  fs.writeFileSync(src, Buffer.from(await res.arrayBuffer()));
  const out = path.join(mixedDir, `${versionId}-vo.mp4`);
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile(env.ffmpegPath, ["-y", "-i", src, "-i", mp3, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", out], { timeout: 120000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg failed: ${String(stderr).slice(-400) || err.message}`));
      else resolve();
    });
  });
  fs.rmSync(src, { force: true });
  return `${env.publicUrl}/media/renders/${versionId}-vo.mp4`;
}
export function mixedFilePath(versionId: string) {
  return path.join(mixedDir, `${versionId}-vo.mp4`);
}

/**
 * Voiceovers waiting to be mixed: versionId → voiceoverId. Recorded the moment a
 * render with a voiceover is requested, so the mix still happens if the caller's
 * request times out before the render finishes (get_video_status does it then).
 */
const pendingVoiceovers = new JsonStore<{ id: string; voiceoverId: string }>("pending-voiceovers");

/** Returns the narrated mp4 URL for a finished version, mixing it first if a voiceover is pending. */
async function finalMp4Url(versionId: string): Promise<{ mp4Url: string; narrated: boolean }> {
  const silent = `${env.publicUrl}/media/renders/${versionId}.mp4`;
  if (fs.existsSync(mixedFilePath(versionId))) return { mp4Url: `${env.publicUrl}/media/renders/${versionId}-vo.mp4`, narrated: true };
  const pending = pendingVoiceovers.get(versionId);
  if (!pending) return { mp4Url: silent, narrated: false };
  try {
    const url = await mixVoiceover(versionId, pending.voiceoverId);
    return { mp4Url: url, narrated: true };
  } catch (e) {
    console.error(`[video-mcp] voiceover mix failed for ${versionId}: ${(e as Error).message}`);
    return { mp4Url: silent, narrated: false };
  }
}

async function waitForGenJob(projectId: string, jobId: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await remotion<RemotionProject>("GET", `/api/projects/${projectId}`);
    const job = state.genJobs.find((j) => j.id === jobId);
    if (job?.status === "done") return { state, job };
    if (job?.status === "failed") throw new Error(`generation failed: ${job.error ?? "unknown error"}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`generation still running after ${Math.round(timeoutMs / 1000)}s; call get_video_status later`);
}

export function buildVideoServer(): McpServer {
  const server = new McpServer({ name: "video", version: "0.1.0" });

  server.registerTool(
    "create_video",
    {
      title: "Create video",
      description:
        "Generates a new motion-graphics video from a text brief using the Remotion code-generation pipeline. Returns projectId, versionId and a free browser preview URL. Takes 1-3 minutes.",
      inputSchema: {
        brief: z.string().min(10).describe("What the video should show, including any real numbers, places or names"),
        title: z.string().optional(),
        author: z.string().optional().describe("Agent name"),
      },
    },
    async ({ brief, title, author }) => {
      try {
        const { projectId, jobId } = await remotion<{ projectId: string; jobId: string }>("POST", "/api/projects", { prompt: brief });
        videoLibrary.insert({ id: projectId, title: title ?? brief.slice(0, 60), prompt: brief, createdBy: author ?? "agent", createdAt: new Date().toISOString(), deleted: false });
        const { state } = await waitForGenJob(projectId, jobId, env.videoGenTimeoutMs);
        return text({ ok: true, projectId, versionId: state.project.current_version_id, previewUrl: previewUrl(projectId), scenes: state.versions.length });
      } catch (e) {
        return fail(`create_video failed: ${(e as Error).message}. Is the Remotion-Agent API running at ${env.remotionApiUrl}?`);
      }
    },
  );

  server.registerTool(
    "edit_video",
    {
      title: "Edit video",
      description: "Applies a natural-language edit to an existing video (e.g. 'make the title blue, shorten scene 2'). Produces a new immutable version. Cheap: one LLM revision call.",
      inputSchema: { project_id: z.string(), instruction: z.string().min(3) },
    },
    async ({ project_id, instruction }) => {
      const entry = videoLibrary.get(project_id);
      if (entry?.deleted) return fail(`project ${project_id} was deleted`);
      try {
        const { jobId } = await remotion<{ jobId: string }>("POST", `/api/projects/${project_id}/edit`, { instruction });
        const { state } = await waitForGenJob(project_id, jobId, env.videoGenTimeoutMs);
        return text({ ok: true, projectId: project_id, versionId: state.project.current_version_id, version: state.versions.length, previewUrl: previewUrl(project_id) });
      } catch (e) {
        return fail(`edit_video failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "preview_video",
    {
      title: "Preview video",
      description: "Returns the browser preview URL for a project's current version. Free: compiled client-side, no render.",
      inputSchema: { project_id: z.string() },
    },
    async ({ project_id }) => {
      try {
        const state = await remotion<RemotionProject>("GET", `/api/projects/${project_id}`);
        return text({ projectId: project_id, versionId: state.project.current_version_id, previewUrl: previewUrl(project_id), versions: state.versions.length });
      } catch (e) {
        return fail(`preview_video failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "render_final",
    {
      title: "Render final MP4",
      description: "Renders a full 1080p MP4 of a specific version. Uses real CPU/Chromium time (costly). With wait=true (default) it blocks until the render finishes (up to ~12 minutes) and returns a public mp4Url that can be sent to the social channels or embedded in a post. Pass voiceover_id (from generate_voiceover) to mix that narration into the MP4; the narration is mixed in even if this call times out, and get_video_status then returns the narrated mp4Url.",
      inputSchema: {
        project_id: z.string(),
        version_id: z.string().optional().describe("Defaults to the current version"),
        wait: z.boolean().default(true).describe("Wait for the render to finish"),
        voiceover_id: z.string().optional().describe("Voiceover to mix into the video (requires wait=true)"),
      },
    },
    async ({ project_id, version_id, wait, voiceover_id }) => {
      try {
        const state = await remotion<RemotionProject>("GET", `/api/projects/${project_id}`);
        const versionId = version_id ?? state.project.current_version_id;
        if (!versionId) return fail("project has no version to render yet");
        const { jobId } = await remotion<{ jobId: string }>("POST", `/api/projects/${project_id}/render`, { versionId });
        if (voiceover_id) {
          if (!fs.existsSync(path.join(runtimeDir, "voiceovers", `${voiceover_id}.mp3`))) return fail(`voiceover ${voiceover_id} not found`);
          if (pendingVoiceovers.get(versionId)) pendingVoiceovers.update(versionId, { voiceoverId: voiceover_id });
          else pendingVoiceovers.insert({ id: versionId, voiceoverId: voiceover_id });
        }
        const silentUrl = `${env.publicUrl}/media/renders/${versionId}.mp4`;
        if (!wait) return text({ ok: true, projectId: project_id, versionId, renderJobId: jobId, mp4UrlWhenDone: silentUrl, voiceoverId: voiceover_id ?? null, note: "poll get_video_status; it returns the narrated mp4Url when done" });
        const started = Date.now();
        while (Date.now() - started < env.renderWaitMs) {
          const s = await remotion<RemotionProject>("GET", `/api/projects/${project_id}`);
          const job = s.renderJobs.find((j) => j.id === jobId);
          if (job?.status === "done") {
            const { mp4Url, narrated } = await finalMp4Url(versionId);
            return text({ ok: true, projectId: project_id, versionId, renderJobId: jobId, mp4Url, narrated, silentMp4Url: silentUrl, voiceoverId: voiceover_id ?? null });
          }
          if (job?.status === "failed" || job?.status === "cancelled") return fail(`render ${job.status}: ${job.error ?? "unknown error"}`);
          await new Promise((r) => setTimeout(r, 4000));
        }
        return fail(`render still running after ${Math.round(env.renderWaitMs / 60000)} minutes; call get_video_status until it reports done — it returns the narrated mp4Url (job ${jobId})`);
      } catch (e) {
        return fail(`render_final failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "get_video_status",
    {
      title: "Get video status",
      description: "Returns generation and render job status for a project, plus the MP4 URL once a render is done.",
      inputSchema: { project_id: z.string() },
    },
    async ({ project_id }) => {
      try {
        const state = await remotion<RemotionProject>("GET", `/api/projects/${project_id}`);
        const renders = [];
        for (const r of state.renderJobs) {
          const done = r.status === "done";
          const final = done ? await finalMp4Url(r.version_id) : null;
          renders.push({ jobId: r.id, versionId: r.version_id, status: r.status, mp4Url: final?.mp4Url ?? null, narrated: final?.narrated ?? false, error: r.error });
        }
        return text({ projectId: project_id, currentVersionId: state.project.current_version_id, previewUrl: previewUrl(project_id), generation: state.genJobs.slice(0, 3), renders });
      } catch (e) {
        return fail(`get_video_status failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "generate_voiceover",
    {
      title: "Generate voiceover",
      description: "Generates an MP3 voiceover with ElevenLabs for a script. Spends paid characters; capped by the brand kit.",
      inputSchema: { script: z.string().min(1), voice_id: z.string().optional() },
    },
    async ({ script, voice_id }) => {
      const cap = loadBrandKit().maxVoiceoverCharacters;
      if (script.length > cap) return fail(`script is ${script.length} characters; the brand cap is ${cap}. Shorten it.`);
      if (!env.elevenLabsApiKey) return fail("ELEVENLABS_API_KEY is not configured on the MCP host; voiceover unavailable.");
      try {
        const voice = voice_id ?? env.elevenLabsVoiceId;
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
          method: "POST",
          headers: { "xi-api-key": env.elevenLabsApiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text: script, model_id: env.elevenLabsModelId }),
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) return fail(`ElevenLabs returned ${res.status}: ${await res.text()}`);
        const id = shortId("vo");
        const file = path.join(runtimeDir, "voiceovers", `${id}.mp3`);
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        return text({ ok: true, voiceoverId: id, characters: script.length, audioUrl: `${env.publicUrl}/media/voiceovers/${id}.mp3` });
      } catch (e) {
        return fail(`generate_voiceover failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "attach_voiceover",
    {
      title: "Attach voiceover to a rendered video",
      description: "Mixes an existing voiceover (from generate_voiceover) into an already rendered version's MP4 and returns the new mp4Url with narration.",
      inputSchema: { version_id: z.string(), voiceover_id: z.string() },
    },
    async ({ version_id, voiceover_id }) => {
      try {
        const mp4Url = await mixVoiceover(version_id, voiceover_id);
        return text({ ok: true, versionId: version_id, voiceoverId: voiceover_id, mp4Url });
      } catch (e) {
        return fail(`attach_voiceover failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "export_source",
    {
      title: "Export source code",
      description: "Exports the full generated scene source code of a version (the studio's IP). Sensitive.",
      inputSchema: { version_id: z.string() },
    },
    async ({ version_id }) => {
      try {
        const v = await remotion<{ scene_code: unknown }>("GET", `/api/versions/${version_id}`);
        return text(v.scene_code);
      } catch (e) {
        return fail(`export_source failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete project",
      description: "Removes a video project from the studio library. Destructive.",
      inputSchema: { project_id: z.string() },
    },
    async ({ project_id }) => {
      const entry = videoLibrary.get(project_id);
      if (!entry) return fail(`project ${project_id} is not in the library`);
      videoLibrary.update(project_id, { deleted: true });
      return text({ ok: true, projectId: project_id, deleted: true });
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Lists video projects created through the studio.",
      inputSchema: {},
    },
    async () => text(videoLibrary.all().filter((e) => !e.deleted).map((e) => ({ ...e, previewUrl: previewUrl(e.id) }))),
  );

  return server;
}
