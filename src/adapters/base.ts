import { GeminiAdapter } from "./gemini.js";
import { OllamaAdapter } from "./ollama.js";
import { ClaudeAdapter } from "./claude.js";
import { OpenAIAdapter } from "./openai.js";
import type { AgentAdapter } from "../agent/loop.js";

export interface InferenceAdapter {
  review(prompt: string): Promise<string>;
}

export interface AdapterOptions {
  apiKey?: string;
}

export function getAdapter(provider: string, opts?: AdapterOptions): InferenceAdapter {
  switch (provider) {
    case "gemini":
      return new GeminiAdapter(opts?.apiKey);
    case "ollama":
      return new OllamaAdapter();
    case "claude":
      return new ClaudeAdapter(opts?.apiKey);
    case "openai":
      return new OpenAIAdapter(opts?.apiKey);
    default:
      throw new Error(`[verix] Unknown model provider: "${provider}". Supported: gemini, ollama, claude, openai`);
  }
}

export function getAgentAdapter(provider: string, opts?: AdapterOptions): AgentAdapter {
  switch (provider) {
    case "gemini":
      return new GeminiAdapter(opts?.apiKey);
    case "claude":
      return new ClaudeAdapter(opts?.apiKey);
    case "openai":
      return new OpenAIAdapter(opts?.apiKey);
    case "ollama":
      return new OllamaAdapter();
    default:
      throw new Error(`[verix] Unknown model provider: "${provider}". Supported: gemini, claude, openai, ollama`);
  }
}
