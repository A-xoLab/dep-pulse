import type { LlmEcosystem } from './LLMClient';

export interface LlmPromptConfig {
  ecosystem: LlmEcosystem;
  systemPrompt: string;
  fewShotExample: string;
}

// Simplified, focused system prompt - shorter prompts work better with smaller models
const npmSystemPrompt = `You suggest alternative npm packages. Output ONLY a JSON array, nothing else.

Rules:
1. Return real npm packages that exist (exact names)
2. Match the same category (framework→framework, library→library)
3. Prefer popular, maintained packages
4. Return 3-5 alternatives or [] if unsure

Output format: [{"name":"package-name","description":"what it does","reason":"why it's similar"}]`;

// Concrete few-shot example showing expected input→output
const npmFewShotExample = `Example:
Input: Target package: express, Category: library
Output: [{"name":"fastify","description":"Fast and low overhead web framework","reason":"Similar HTTP server framework with better performance"},{"name":"koa","description":"Expressive HTTP middleware framework","reason":"Lightweight alternative by Express creators"},{"name":"hapi","description":"Rich framework for building applications","reason":"Enterprise-grade HTTP server framework"}]

Now suggest alternatives for the target package below. Output ONLY the JSON array:`;

const promptConfigs: Partial<Record<LlmEcosystem, LlmPromptConfig>> = {
  npm: {
    ecosystem: 'npm',
    systemPrompt: npmSystemPrompt,
    fewShotExample: npmFewShotExample,
  },
  // Stubs for future ecosystems (PyPI, crates.io, Go modules, Maven Central).
  // These are intentionally unsupported until implemented to avoid silent fallbacks.
};

export function getPromptConfig(ecosystem: LlmEcosystem): LlmPromptConfig {
  const config = promptConfigs[ecosystem];
  if (!config) {
    throw new Error(`Unsupported LLM ecosystem: ${ecosystem}`);
  }
  return config;
}
