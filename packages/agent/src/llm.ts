import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { env } from "./env.js";
import type { HubTool } from "./mcpHub.js";

export type Message = ChatCompletionMessageParam;

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!env.llm.apiKey) throw new Error("DEEPSEEK_API_KEY is not set");
  client ??= new OpenAI({ apiKey: env.llm.apiKey, baseURL: env.llm.baseUrl });
  return client;
}

export function toOpenAiTools(tools: HubTool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description.slice(0, 1024), parameters: t.inputSchema },
  }));
}

export async function chat(messages: Message[], opts: { tools?: ChatCompletionTool[]; json?: boolean; temperature?: number } = {}) {
  const res = await openai().chat.completions.create({
    model: env.llm.model,
    messages,
    tools: opts.tools && opts.tools.length > 0 ? opts.tools : undefined,
    response_format: opts.json ? { type: "json_object" } : undefined,
    temperature: opts.temperature ?? 0.3,
  });
  const choice = res.choices[0];
  if (!choice) throw new Error("LLM returned no choices");
  return choice.message;
}
