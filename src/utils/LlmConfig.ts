import type { LLMProvider } from '../types';

export type LlmConfigStatus =
  | { status: 'ok'; provider: LLMProvider; model?: string }
  | {
      status: 'missing';
      provider: LLMProvider;
      message: string;
      missingKey?: boolean;
      missingModel?: boolean;
    }
  | { status: 'invalid'; message: string }
  | { status: 'unconfigured' };

type CachedLlmConfig = {
  openRouterApiKey?: string;
  openRouterModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
};

let cachedLlmConfig: CachedLlmConfig = {};

export function updateCachedLlmConfig(config: CachedLlmConfig): void {
  cachedLlmConfig = { ...config };
}

export function evaluateLlmConfig(): LlmConfigStatus {
  const openRouterApiKey = (cachedLlmConfig.openRouterApiKey || '').trim();
  const openRouterModel = (cachedLlmConfig.openRouterModel || '').trim();
  const openaiApiKey = (cachedLlmConfig.openaiApiKey || '').trim();
  const openaiModel = (cachedLlmConfig.openaiModel || '').trim();
  const geminiApiKey = (cachedLlmConfig.geminiApiKey || '').trim();
  const geminiModel = (cachedLlmConfig.geminiModel || '').trim();

  // Provider priority: OpenRouter > OpenAI > Gemini
  if (openRouterApiKey || openRouterModel) {
    if (!openRouterApiKey) {
      return {
        status: 'missing',
        provider: 'openrouter',
        message: 'OpenRouter API key is required. Use DepPulse: Configure API Secrets.',
        missingKey: true,
        missingModel: false,
      };
    }
    if (!openRouterModel) {
      return {
        status: 'missing',
        provider: 'openrouter',
        message: 'OpenRouter model is required.',
        missingKey: false,
        missingModel: true,
      };
    }
    return { status: 'ok', provider: 'openrouter', model: openRouterModel };
  }

  if (openRouterModel && !openRouterApiKey) {
    return {
      status: 'missing',
      provider: 'openrouter',
      message: 'OpenRouter API key is required. Use DepPulse: Configure API Secrets.',
      missingKey: true,
      missingModel: false,
    };
  }

  if (openaiApiKey || openaiModel) {
    if (!openaiApiKey) {
      return {
        status: 'missing',
        provider: 'openai',
        message: 'OpenAI API key and model are both required.',
        missingKey: true,
        missingModel: !openaiModel,
      };
    }
    if (!openaiModel) {
      return {
        status: 'missing',
        provider: 'openai',
        message: 'OpenAI API key and model are both required.',
        missingKey: false,
        missingModel: true,
      };
    }
    return { status: 'ok', provider: 'openai', model: openaiModel };
  }

  if (geminiApiKey || geminiModel) {
    if (!geminiApiKey) {
      return {
        status: 'missing',
        provider: 'gemini',
        message: 'Gemini API key and model are both required.',
        missingKey: true,
        missingModel: !geminiModel,
      };
    }
    if (!geminiModel) {
      return {
        status: 'missing',
        provider: 'gemini',
        message: 'Gemini API key and model are both required.',
        missingKey: false,
        missingModel: true,
      };
    }
    return { status: 'ok', provider: 'gemini', model: geminiModel };
  }

  return { status: 'unconfigured' };
}
