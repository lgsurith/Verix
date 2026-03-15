import type { InferenceAdapter } from "./base.js";
import type { AgentAdapter, AgentMessage } from "../agent/loop.js";
import type { ToolDefinition } from "../agent/tools.js";
import type { ToolCall } from "../agent/tools.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content: {
    parts: GeminiPart[];
  };
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsage;
}

export class GeminiAdapter implements InferenceAdapter, AgentAdapter {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || "";
    if (!this.apiKey) {
      throw new Error("[verix] GEMINI_API_KEY is not set in .env");
    }
  }

  // --- Simple one-shot review (existing) ---

  async review(prompt: string): Promise<string> {
    const url = `${GEMINI_API_BASE}/gemini-2.0-flash:generateContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`[verix] Gemini API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error("[verix] Gemini returned empty response");
    }

    return text;
  }

  // --- Agentic chat with tool calling ---

  async chat(
    messages: AgentMessage[],
    tools: ToolDefinition[]
  ): Promise<{ message: string | null; toolCalls: ToolCall[] | null }> {
    const url = `${GEMINI_API_BASE}/gemini-2.0-flash:generateContent?key=${this.apiKey}`;

    // Convert our messages to Gemini format
    const { contents, systemInstruction } = this.convertMessages(messages);

    // Convert tool definitions to Gemini format
    const geminiTools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];

    const body: Record<string, unknown> = {
      contents,
      tools: geminiTools,
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 4096,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`[verix] Gemini API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const parts = data.candidates?.[0]?.content?.parts ?? [];

    const partTypes = parts.map((p) => p.functionCall ? `functionCall:${p.functionCall.name}` : "text").join(", ");
    const usage = data.usageMetadata;
    console.log(`[verix:gemini] Response parts: [${partTypes}] | tokens: ${usage?.promptTokenCount ?? "?"}in/${usage?.candidatesTokenCount ?? "?"}out (${usage?.totalTokenCount ?? "?"}total)`);

    // Extract text and tool calls from response
    let message: string | null = null;
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if (part.text) {
        message = part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          name: part.functionCall.name,
          args: part.functionCall.args,
        });
      }
    }

    return {
      message,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
    };
  }

  // --- Convert AgentMessage[] to Gemini's content format ---

  private convertMessages(messages: AgentMessage[]): {
    contents: GeminiContent[];
    systemInstruction: string | null;
  } {
    let systemInstruction: string | null = null;
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemInstruction = msg.content;
        continue;
      }

      if (msg.role === "user") {
        contents.push({
          role: "user",
          parts: [{ text: msg.content }],
        });
        continue;
      }

      if (msg.role === "assistant") {
        const parts: GeminiPart[] = [];

        if ("tool_calls" in msg && msg.tool_calls) {
          // Assistant message with tool calls
          if (msg.content) parts.push({ text: msg.content });
          for (const tc of msg.tool_calls) {
            parts.push({
              functionCall: { name: tc.name, args: tc.args },
            });
          }
        } else {
          parts.push({ text: msg.content ?? "" });
        }

        contents.push({ role: "model", parts });
        continue;
      }

      if (msg.role === "tool") {
        // Tool results go as user messages with functionResponse parts in Gemini
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: msg.name,
                response: { content: msg.content },
              },
            },
          ],
        });
        continue;
      }
    }

    return { contents, systemInstruction };
  }
}
