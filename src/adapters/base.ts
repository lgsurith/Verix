import { GeminiAdapter } from "./gemini.js";
import { OllamaAdapter } from "./ollama.js";
import { ClaudeAdapter } from "./claude.js";
import { OpenAIAdapter } from "./openai.js";
import type { AgentAdapter } from "../agent/loop.js";

export interface InferenceAdapter {
  review(prompt: string): Promise<string>;
}

export function getAdapter(provider: string): InferenceAdapter {
  switch (provider) {
    case "gemini":
      return new GeminiAdapter();
    case "ollama":
      return new OllamaAdapter();
    case "claude":
      return new ClaudeAdapter();
    case "openai":
      return new OpenAIAdapter();
    default:
      throw new Error(`[verix] Unknown model provider: "${provider}". Supported: gemini, ollama, claude, openai`);
  }
}

export function getAgentAdapter(provider: string): AgentAdapter {
  switch (provider) {
    case "gemini":
      return new GeminiAdapter();
    case "claude":
      return new ClaudeAdapter();
    case "openai":
      return new OpenAIAdapter();
    case "ollama":
      return new OllamaAdapter();
    default:
      throw new Error(`[verix] Unknown model provider: "${provider}". Supported: gemini, claude, openai, ollama`);
  }
}
