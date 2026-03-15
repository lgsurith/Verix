import type { InferenceAdapter } from "./base.js";
import type { AgentAdapter, AgentMessage } from "../agent/loop.js";
import type { ToolDefinition } from "../agent/tools.js";
import type { ToolCall } from "../agent/tools.js";

interface ClaudeContent {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContent[];
}

interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
}

interface ClaudeResponse {
  content: ClaudeContent[];
  usage?: ClaudeUsage;
  stop_reason?: string;
}

export class ClaudeAdapter implements InferenceAdapter, AgentAdapter {
  private apiKey: string;
  private model: string;

  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY || "";
    if (!this.apiKey) {
      throw new Error("[verix] ANTHROPIC_API_KEY is not set in .env");
    }
    this.model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
  }

  // --- One-shot review ---

  async review(prompt: string): Promise<string> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`[verix] Claude API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as ClaudeResponse;
    const text = data.content?.[0]?.text;

    if (!text) {
      throw new Error("[verix] Claude returned empty response");
    }

    return text;
  }

  // --- Agentic chat with tool calling ---

  async chat(
    messages: AgentMessage[],
    tools: ToolDefinition[]
  ): Promise<{ message: string | null; toolCalls: ToolCall[] | null }> {
    const { claudeMessages, systemPrompt } = this.convertMessages(messages);

    const claudeTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      temperature: 0.3,
      messages: claudeMessages,
      tools: claudeTools,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`[verix] Claude API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as ClaudeResponse;
    const usage = data.usage;
    console.log(`[verix:claude] tokens: ${usage?.input_tokens ?? "?"}in/${usage?.output_tokens ?? "?"}out`);

    let message: string | null = null;
    const toolCalls: ToolCall[] = [];

    for (const block of data.content) {
      if (block.type === "text" && block.text) {
        message = block.text;
      }
      if (block.type === "tool_use" && block.name && block.input) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input,
        });
      }
    }

    return {
      message,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
    };
  }

  // --- Convert AgentMessage[] to Claude format ---

  private convertMessages(messages: AgentMessage[]): {
    claudeMessages: ClaudeMessage[];
    systemPrompt: string | null;
  } {
    let systemPrompt: string | null = null;
    const claudeMessages: ClaudeMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemPrompt = msg.content;
        continue;
      }

      if (msg.role === "user") {
        claudeMessages.push({ role: "user", content: msg.content });
        continue;
      }

      if (msg.role === "assistant") {
        if ("tool_calls" in msg && msg.tool_calls) {
          const content: ClaudeContent[] = [];
          if (msg.content) content.push({ type: "text", text: msg.content });
          for (const tc of msg.tool_calls) {
            content.push({
              type: "tool_use",
              id: tc.id ?? `call_${tc.name}`,
              name: tc.name,
              input: tc.args,
            });
          }
          claudeMessages.push({ role: "assistant", content });
        } else {
          claudeMessages.push({ role: "assistant", content: msg.content ?? "" });
        }
        continue;
      }

      if (msg.role === "tool") {
        // Claude expects tool results as user messages with tool_result content
        claudeMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id ?? `call_${msg.name}`,
              content: msg.content,
            },
          ],
        });
        continue;
      }
    }

    return { claudeMessages, systemPrompt };
  }
}
