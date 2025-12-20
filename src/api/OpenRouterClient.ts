import type * as vscode from 'vscode';
import { BaseAPIClient } from './APIClient';
import type { LLMAlternativeRequest, LLMClient } from './LLMClient';
import { parseLLMAlternatives } from './LLMClient';
import { getPromptConfig, type LlmPromptConfig } from './llmPromptConfig';

interface OpenRouterChatChoice {
  message?: {
    content?: string;
  };
}

interface OpenRouterChatResponse {
  choices?: OpenRouterChatChoice[];
}

export class OpenRouterClient extends BaseAPIClient implements LLMClient {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, outputChannel: vscode.OutputChannel, model: string) {
    super('https://openrouter.ai/api', outputChannel);
    this.apiKey = apiKey;
    if (!model || model.trim().length === 0) {
      throw new Error('OpenRouter model is required. Please specify a model in DepPulse settings.');
    }
    this.model = model;
  }

  async generateAlternatives(request: LLMAlternativeRequest) {
    const promptConfig = getPromptConfig(request.ecosystem);
    const prompt = this.buildPrompt(request, promptConfig);
    const body = {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: promptConfig.systemPrompt,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.2,
      top_p: 1,
      max_tokens: 400,
    };

    const response = await this.post<OpenRouterChatResponse, typeof body>(
      '/v1/chat/completions',
      body,
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        timeout: 20000,
      }
    );

    const content = response.choices?.[0]?.message?.content ?? '';
    this.log('info', `[LLM raw response] ${content}`);
    return parseLLMAlternatives(content);
  }

  private buildPrompt(request: LLMAlternativeRequest, promptConfig: LlmPromptConfig): string {
    const targetInfo = [
      `Target package: ${request.packageName}`,
      request.description ? `Description: ${request.description}` : undefined,
      request.categoryHint ? `Category: ${request.categoryHint}` : undefined,
    ]
      .filter(Boolean)
      .join(', ');

    return `${promptConfig.fewShotExample}\n\n${targetInfo}`;
  }
}
