
import type { InferenceAdapter } from "./base.js";
import type { AgentAdapter, AgentMessage } from "../agent/loop.js";
import type { ToolDefinition } from "../agent/tools.js";
import type { ToolCall } from "../agent/tools.js";

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: OpenAIUsage;
}

export class OpenAIAdapter implements InferenceAdapter, AgentAdapter {
  private apiKey: string;
  private model: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY ?? "";
    if (!this.apiKey) {
      throw new Error("[verix] OPENAI_API_KEY is not set");
    }
    this.model = process.env.OPENAI_MODEL || "gpt-4o";
  }

  // --- One-shot review ---

  async review(prompt: string): Promise<string> {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.3,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`[verix] OpenAI API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    const text = data.choices?.[0]?.message?.content;

    if (!text) {
      throw new Error("[verix] OpenAI returned empty response");
    }

    return text;
  }

  // --- Agentic chat with tool calling ---

  async chat(
    messages: AgentMessage[],
    tools: ToolDefinition[]
  ): Promise<{ message: string | null; toolCalls: ToolCall[] | null }> {
    const openaiMessages = this.convertMessages(messages);

    const openaiTools = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.3,
        max_tokens: 4096,
        messages: openaiMessages,
        tools: openaiTools,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`[verix] OpenAI API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    const usage = data.usage;
    console.log(`[verix:openai] tokens: ${usage?.prompt_tokens ?? "?"}in/${usage?.completion_tokens ?? "?"}out (${usage?.total_tokens ?? "?"}total)`);

    const choice = data.choices?.[0]?.message;
    if (!choice) {
      return { message: null, toolCalls: null };
    }

    const message = choice.content;
    const toolCalls: ToolCall[] = [];

    if (choice.tool_calls) {
      for (const tc of choice.tool_calls) {
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          toolCalls.push({ id: tc.id, name: tc.function.name, args });
        } catch {
          console.error(`[verix] Failed to parse OpenAI tool args: ${tc.function.arguments}`);
        }
      }
    }

    return {
      message,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
    };
  }

  // --- Convert AgentMessage[] to OpenAI format ---

  private convertMessages(messages: AgentMessage[]): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];
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
          const openaiToolCalls = msg.tool_calls.map((tc) => ({
            id: tc.id ?? `call_${tc.name}`,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          }));
          result.push({
            role: "assistant",
            content: msg.content,
            tool_calls: openaiToolCalls,
          });
        } else {
          result.push({ role: "assistant", content: msg.content ?? "" });
        }
        continue;
      }

      if (msg.role === "tool") {
        result.push({
          role: "tool",
          content: msg.content,
          tool_call_id: msg.tool_call_id ?? `call_${msg.name}`,
        });
        continue;
      }
    }

    return result;
  }
}
