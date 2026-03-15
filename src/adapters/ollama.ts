import type { InferenceAdapter } from "./base.js";
import type { AgentAdapter, AgentMessage } from "../agent/loop.js";
import type { ToolDefinition } from "../agent/tools.js";
import type { ToolCall } from "../agent/tools.js";

// Ollama uses OpenAI-compatible chat format for tool calling

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaChatResponse {
  message: {
    role: "assistant";
    content: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaGenerateResponse {
  response: string;
}

export class OllamaAdapter implements InferenceAdapter, AgentAdapter {
  private baseUrl: string;
  private model: string;

  constructor() {
    this.baseUrl = process.env.OLLAMA_URL || "http://localhost:11434";
    this.model = process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";
  }

  // --- One-shot review ---

  async review(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 4096,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`[verix] Ollama error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as OllamaGenerateResponse;

    if (!data.response) {
      throw new Error("[verix] Ollama returned empty response");
    }

    return data.response;
  }

  // --- Agentic chat with tool calling ---
  // Uses Ollama's /api/chat endpoint which supports OpenAI-compatible tool calling

  async chat(
    messages: AgentMessage[],
    tools: ToolDefinition[]
  ): Promise<{ message: string | null; toolCalls: ToolCall[] | null }> {
    const ollamaMessages = this.convertMessages(messages);

    const ollamaTools = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: ollamaMessages,
        tools: ollamaTools,
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 4096,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`[verix] Ollama error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    console.log(`[verix:ollama] tokens: ${data.prompt_eval_count ?? "?"}in/${data.eval_count ?? "?"}out`);

    const message = data.message?.content || null;
    const toolCalls: ToolCall[] = [];

    if (data.message?.tool_calls) {
      for (const tc of data.message.tool_calls) {
        toolCalls.push({
          name: tc.function.name,
          args: tc.function.arguments,
        });
      }
    }

    return {
      message,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
    };
  }

  // --- Convert AgentMessage[] to Ollama format ---

  private convertMessages(messages: AgentMessage[]): OllamaMessage[] {
    const result: OllamaMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        result.push({ role: "system", content: msg.content });
        continue;
      }

      if (msg.role === "user") {
        result.push({ role: "user", content: msg.content });
        continue;
      }

      if (msg.role === "assistant") {
        if ("tool_calls" in msg && msg.tool_calls) {
          result.push({
            role: "assistant",
            content: msg.content ?? "",
            tool_calls: msg.tool_calls.map((tc) => ({
              function: { name: tc.name, arguments: tc.args as Record<string, unknown> },
            })),
          });
        } else {
          result.push({ role: "assistant", content: msg.content ?? "" });
        }
        continue;
      }

      if (msg.role === "tool") {
        result.push({ role: "tool", content: msg.content, tool_name: msg.name });
        continue;
      }
    }

    return result;
  }
}
