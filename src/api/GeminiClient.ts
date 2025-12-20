import type * as vscode from 'vscode';
import { BaseAPIClient } from './APIClient';
import type { LLMAlternativeRequest, LLMClient } from './LLMClient';
import { parseLLMAlternatives } from './LLMClient';
import { getPromptConfig, type LlmPromptConfig } from './llmPromptConfig';

interface GeminiContentPart {
  text?: string;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiContentPart[];
  };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

export class GeminiClient extends BaseAPIClient implements LLMClient {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, outputChannel: vscode.OutputChannel, model: string) {
    super('https://generativelanguage.googleapis.com', outputChannel);
    this.apiKey = apiKey;
    if (!model || model.trim().length === 0) {
      throw new Error('Gemini model is required');
    }
    this.model = model;
  }

  async generateAlternatives(request: LLMAlternativeRequest) {
    const promptConfig = getPromptConfig(request.ecosystem);
    const prompt = this.buildPrompt(request, promptConfig);
    const isThinkingModel =
      this.model.toLowerCase().includes('thinking') || this.model.toLowerCase().includes('3-pro');
    const maxOutputTokens = isThinkingModel ? 4096 : 1024;
    const timeout = isThinkingModel ? 60000 : 30000;

    // Try both endpoints: some preview models only work on v1beta, some on v1.
    const endpoints = [
      `/v1/models/${this.model}:generateContent`,
      `/v1beta/models/${this.model}:generateContent`,
    ];

    let lastError: unknown;

    for (const endpoint of endpoints) {
      const useV1beta = endpoint.includes('/v1beta/');
      const body = {
        contents: [
          {
            role: 'user',
            parts: [{ text: `${promptConfig.systemPrompt}\n\n${prompt}` }],
          },
        ],
        generationConfig: {
          temperature: 0.35,
          topP: 0.9,
          maxOutputTokens,
          ...(useV1beta ? { responseMimeType: 'application/json' } : {}),
        },
      };

      try {
        const response = await this.post<GeminiResponse, typeof body>(endpoint, body, {
          timeout,
          headers: {
            'x-goog-api-key': this.apiKey,
          },
        });

        const content = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        this.log('info', `[LLM raw response] ${content}`);
        return parseLLMAlternatives(content);
      } catch (error) {
        const status =
          (error as { response?: { status?: number } })?.response?.status ??
          (error as { context?: { status?: number } })?.context?.status;

        const isModelNotFound = status === 404 || status === 400;

        // If the first endpoint misses, keep trying the next.
        if (isModelNotFound) {
          lastError = error;
          continue;
        }

        throw error;
      }
    }

    throw lastError ?? new Error('Gemini request failed.');
  }

  private buildPrompt(request: LLMAlternativeRequest, promptConfig: LlmPromptConfig): string {
    const targetInfo = [
      `Target package: ${request.packageName}`,
      request.description ? `Description: ${request.description}` : undefined,
      request.categoryHint ? `Category: ${request.categoryHint}` : undefined,
    ]
      .filter(Boolean)
      .join(', ');

    const constraint = [
      'Return ONLY a JSON array with up to 3 distinct, real npm packages.',
      'No placeholders, no private/internal packages. If none are suitable, return [].',
    ].join(' ');

    return `${promptConfig.fewShotExample}\n\n${targetInfo}\n\n${constraint}`;
  }
}
