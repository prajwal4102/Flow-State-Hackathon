/**
 * Launcher for the public @node2flow/telegram-bot-mcp server.
 *
 * The package (v1.0.4) hands plain JSON Schema objects to McpServer.registerTool,
 * which current MCP SDKs reject ("inputSchema must be a Zod schema or raw shape").
 * This launcher converts each tool's JSON Schema into a Zod raw shape right before
 * registration and then starts the package unchanged in its own HTTP mode.
 * Nothing in node_modules is modified.
 *
 *   TELEGRAM_BOT_TOKEN=... PORT=4300 node launch.mjs --http
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function fieldFromJsonSchema(p) {
  let s;
  const type = Array.isArray(p.type) ? p.type : [p.type];
  if (Array.isArray(p.enum) && p.enum.every((v) => typeof v === "string") && p.enum.length > 0) {
    s = z.enum(p.enum);
  } else if (type.length > 1) {
    s = z.union(type.map((t) => fieldFromJsonSchema({ ...p, type: t, enum: undefined })));
  } else {
    switch (type[0]) {
      case "string":
        s = z.string();
        break;
      case "integer":
        s = z.number().int();
        break;
      case "number":
        s = z.number();
        break;
      case "boolean":
        s = z.boolean();
        break;
      case "array":
        s = z.array(p.items && typeof p.items === "object" ? fieldFromJsonSchema(p.items) : z.any());
        break;
      case "object":
        s = p.properties ? z.object(shapeFromJsonSchema(p)) : z.record(z.string(), z.any());
        break;
      default:
        s = z.any();
    }
  }
  return p.description ? s.describe(p.description) : s;
}

function shapeFromJsonSchema(schema) {
  const required = new Set(schema.required ?? []);
  const shape = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const f = fieldFromJsonSchema(prop ?? {});
    shape[key] = required.has(key) ? f : f.optional();
  }
  return shape;
}

const isZodLike = (v) => v && typeof v === "object" && ("_def" in v || "_zod" in v || "~standard" in v);

const original = McpServer.prototype.registerTool;
McpServer.prototype.registerTool = function (name, config, callback) {
  const input = config?.inputSchema;
  if (input && typeof input === "object" && !isZodLike(input) && input.type === "object") {
    config = { ...config, inputSchema: shapeFromJsonSchema(input) };
  }
  return original.call(this, name, config, callback);
};

// The package runs main() on import and reads --http / PORT / TELEGRAM_BOT_TOKEN itself.
await import("./node_modules/@node2flow/telegram-bot-mcp/dist/index.js");
