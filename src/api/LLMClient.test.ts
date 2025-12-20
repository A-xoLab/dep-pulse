import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { GeminiClient } from './GeminiClient';
import { type LLMAlternativeRequest, parseLLMAlternatives } from './LLMClient';
import { OpenAIClient } from './OpenAIClient';
import { OpenRouterClient } from './OpenRouterClient';

const createOutputChannel = (): vscode.OutputChannel =>
  ({
    appendLine: vi.fn(),
    show: vi.fn(),
  }) as unknown as vscode.OutputChannel;

describe('parseLLMAlternatives', () => {
  it('parses JSON arrays', () => {
    const text = `[{"name":"pkg-a","description":"desc"}]`;
    const result = parseLLMAlternatives(text);
    expect(result).toEqual([{ name: 'pkg-a', description: 'desc', reason: undefined }]);
  });

  it('returns empty for non-JSON input (strict mode)', () => {
    // Bullet lists are no longer parsed - only valid JSON arrays are accepted
    const text = '- pkg-a: desc\n- pkg-b: another';
    const result = parseLLMAlternatives(text);
    expect(result).toEqual([]);
  });
});

describe('LLM clients', () => {
  const request: LLMAlternativeRequest = {
    packageName: 'left-pad',
    description: 'legacy padding library',
    packageManager: 'npm' as const,
    limit: 3,
    ecosystem: 'npm',
  };

  it('OpenAIClient returns parsed suggestions', async () => {
    const client = new OpenAIClient('key', createOutputChannel(), 'test-model');
    const postSpy = vi
      .spyOn(client as unknown as { post: OpenAIClient['post'] }, 'post')
      .mockResolvedValue({
        choices: [{ message: { content: '[{"name":"alt-a","description":"modern"}]' } }],
      });

    const result = await client.generateAlternatives(request);
    expect(postSpy).toHaveBeenCalled();
    expect(result[0]).toMatchObject({ name: 'alt-a', description: 'modern' });
    expect(postSpy).toHaveBeenCalledWith(
      '/v1/chat/completions',
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringContaining('Bearer'),
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('OpenRouterClient returns parsed suggestions', async () => {
    const client = new OpenRouterClient(
      'key',
      createOutputChannel(),
      'anthropic/claude-3.5-sonnet'
    );
    const postSpy = vi
      .spyOn(client as unknown as { post: OpenRouterClient['post'] }, 'post')
      .mockResolvedValue({
        choices: [{ message: { content: '[{"name":"router-alt"}]' } }],
      });

    const result = await client.generateAlternatives(request);
    expect(postSpy).toHaveBeenCalled();
    expect(result[0]).toMatchObject({ name: 'router-alt' });
  });

  it('GeminiClient returns parsed suggestions', async () => {
    const client = new GeminiClient('key', createOutputChannel(), 'test-model');
    const postSpy = vi
      .spyOn(client as unknown as { post: GeminiClient['post'] }, 'post')
      .mockResolvedValue({
        candidates: [{ content: { parts: [{ text: '[{"name":"gemini-alt"}]' }] } }],
      });

    const result = await client.generateAlternatives(request);
    expect(postSpy).toHaveBeenCalled();
    expect(result[0]).toMatchObject({ name: 'gemini-alt' });
  });

  it('GeminiClient falls back to v1 when v1beta returns 404', async () => {
    const client = new GeminiClient('key', createOutputChannel(), 'test-model');
    const postSpy = vi
      .spyOn(client as unknown as { post: GeminiClient['post'] }, 'post')
      .mockRejectedValueOnce({ context: { status: 404 } })
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: '[{"name":"gemini-alt-2"}]' }] } }],
      });

    const result = await client.generateAlternatives(request);
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(postSpy.mock.calls[0][0]).toContain('/v1/models');
    expect(postSpy.mock.calls[1][0]).toContain('/v1beta/models');
    expect(postSpy.mock.calls[1][2]?.headers?.['x-goog-api-key']).toBe('key');
    expect(result[0]).toMatchObject({ name: 'gemini-alt-2' });
  });
});
