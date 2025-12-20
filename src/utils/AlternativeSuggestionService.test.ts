import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { NpmRegistryClient } from '../api/NpmRegistryClient';
import type { LLMAlternativeCandidate } from '../types';
import { LLMAlternativeSuggestionService } from './AlternativeSuggestionService';
import { NetworkStatusService } from './NetworkStatusService';

const createOutputChannel = (): vscode.OutputChannel =>
  ({
    appendLine: vi.fn(),
    show: vi.fn(),
  }) as unknown as vscode.OutputChannel;

describe('LLMAlternativeSuggestionService', () => {
  it('returns LLM suggestions enriched with registry data', async () => {
    // Both candidates must share keywords with target for semantic relevance check
    const llmCandidates: LLMAlternativeCandidate[] = [
      { name: 'modern-utils', description: 'Modern javascript utility library' },
      { name: 'popular-utils', description: 'Popular javascript utility library' },
    ];

    const mockClientOverride = {
      generateAlternatives: vi.fn(async (_request) => llmCandidates),
    };

    const mockRegistry = {
      getDownloadStats: vi.fn().mockResolvedValue({ weekly: 50_000, monthly: 0, total: 50_000 }),
      getPackageInfo: vi.fn().mockImplementation(async (name: string) => {
        // Target package - shares "javascript" and "utility" keywords with candidates
        if (name === 'legacy-utils') {
          return { name: 'legacy-utils', description: 'Legacy javascript utility library' };
        }
        // LLM candidates - must return info for exact match validation
        if (name === 'modern-utils') {
          return { name: 'modern-utils', description: 'Modern javascript utility library' };
        }
        if (name === 'popular-utils') {
          return { name: 'popular-utils', description: 'Popular javascript utility library' };
        }
        throw new Error('not found');
      }),
    } as unknown as NpmRegistryClient;

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: 'openrouter',
      apiKey: 'test',
      outputChannel: createOutputChannel(),
      clientOverride: mockClientOverride,
    });

    const suggestions = await service.getSuggestions(
      'legacy-utils',
      'npm',
      'Legacy javascript utility library'
    );

    expect(mockClientOverride.generateAlternatives).toHaveBeenCalled();
    expect(mockRegistry.getDownloadStats).toHaveBeenCalledWith('modern-utils');
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].name).toBe('modern-utils');
    expect(suggestions[0].weeklyDownloads).toBe(50_000);
    expect(suggestions[0].installCommand).toBe('npm install modern-utils');
  });

  it('only accepts exact npm package names (no search-based substitution)', async () => {
    // LLM returns exact package names - now validated directly against npm
    const llmCandidates: LLMAlternativeCandidate[] = [
      { name: '@sveltejs/kit', description: 'Svelte framework for building web apps' },
    ];

    const mockClientOverride = {
      generateAlternatives: vi.fn(async (_request) => llmCandidates),
    };

    const mockRegistry = {
      getDownloadStats: vi.fn().mockResolvedValue({ weekly: 500_000, monthly: 0, total: 500_000 }),
      getPackageInfo: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'legacy-lib') {
          return { name: 'legacy-lib', description: 'Legacy web framework package' };
        }
        if (name === '@sveltejs/kit') {
          return { name: '@sveltejs/kit', description: 'Svelte framework for building web apps' };
        }
        throw new Error('not found');
      }),
      searchPackages: vi.fn(),
    } as unknown as NpmRegistryClient;

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: 'openrouter',
      apiKey: 'test',
      outputChannel: createOutputChannel(),
      clientOverride: mockClientOverride,
    });

    const suggestions = await service.getSuggestions('legacy-lib', 'pnpm', 'Legacy web framework');

    // No search should be called - we use exact name matching only
    expect(mockRegistry.searchPackages).not.toHaveBeenCalled();
    expect(suggestions[0].name).toBe('@sveltejs/kit');
    expect(suggestions[0].installCommand).toBe('pnpm add @sveltejs/kit');
  });

  it('discards candidates that do not exist on npm', async () => {
    // LLM returns a package name that doesn't exist
    const llmCandidates: LLMAlternativeCandidate[] = [
      { name: 'nonexistent-package', description: 'Does not exist' },
      { name: 'remix', description: 'Full stack web framework' },
    ];

    const mockRegistry = {
      getPackageInfo: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'legacy-lib') {
          return { name: 'legacy-lib', description: 'Legacy web framework' };
        }
        if (name === 'remix') {
          return { name: 'remix', description: 'Full stack web framework' };
        }
        // nonexistent-package throws - simulating 404
        throw new Error('not found');
      }),
      getDownloadStats: vi
        .fn()
        .mockResolvedValue({ weekly: 2_000_000, monthly: 0, total: 2_000_000 }),
      searchPackages: vi.fn(),
    } as unknown as NpmRegistryClient;

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: 'openrouter',
      apiKey: 'test',
      outputChannel: createOutputChannel(),
      clientOverride: {
        generateAlternatives: vi.fn(async () => llmCandidates),
      },
    });

    const suggestions = await service.getSuggestions('legacy-lib', 'npm', 'Legacy web framework');

    // Only remix should be returned since nonexistent-package doesn't exist on npm
    expect(suggestions.map((s) => s.name)).toEqual(['remix']);
  });

  it('throws when not configured', async () => {
    const mockRegistry = {
      getDownloadStats: vi.fn(),
      getPackageInfo: vi.fn(),
    } as unknown as NpmRegistryClient;

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: undefined,
      apiKey: '',
      outputChannel: createOutputChannel(),
    });

    await expect(service.getSuggestions('legacy-lib', 'npm')).rejects.toThrow(
      /LLM alternatives are disabled/i
    );
  });

  it('normalizes auth errors', async () => {
    const mockRegistry = {
      getDownloadStats: vi.fn(),
      getPackageInfo: vi.fn(),
    } as unknown as NpmRegistryClient;

    const mockClientOverride = {
      generateAlternatives: vi
        .fn()
        .mockRejectedValue(new Error('401 Unauthorized: invalid api key')),
    };

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: 'openrouter',
      apiKey: 'bad',
      outputChannel: createOutputChannel(),
      clientOverride: mockClientOverride,
    });

    await expect(service.getSuggestions('legacy-lib', 'npm')).rejects.toThrow(
      /authentication failed/i
    );
  });

  it('normalizes quota errors', async () => {
    const mockRegistry = {
      getDownloadStats: vi.fn(),
      getPackageInfo: vi.fn(),
    } as unknown as NpmRegistryClient;

    const mockClientOverride = {
      generateAlternatives: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    };

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: 'openrouter',
      apiKey: 'bad',
      outputChannel: createOutputChannel(),
      clientOverride: mockClientOverride,
    });

    await expect(service.getSuggestions('legacy-lib', 'npm')).rejects.toThrow(/quota/i);
  });

  it('honors simulated offline mode', async () => {
    const networkService = NetworkStatusService.getInstance();
    networkService.setSimulateOffline(true);

    const mockRegistry = {
      getDownloadStats: vi.fn(),
      getPackageInfo: vi.fn(),
    } as unknown as NpmRegistryClient;

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: 'openrouter',
      apiKey: 'test',
      outputChannel: createOutputChannel(),
      clientOverride: { generateAlternatives: vi.fn() },
    });

    await expect(service.getSuggestions('legacy-lib', 'npm')).rejects.toThrow(
      /simulated offline mode/i
    );

    networkService.setSimulateOffline(false);
  });

  it('throws unsupported ecosystem error without falling back', async () => {
    const mockRegistry = {
      getDownloadStats: vi.fn(),
      getPackageInfo: vi.fn(),
    } as unknown as NpmRegistryClient;

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: 'openrouter',
      apiKey: 'test',
      model: 'anthropic/claude-3.5-sonnet', // Model now required
      outputChannel: createOutputChannel(),
      ecosystem: 'pypi',
    });

    await expect(service.getSuggestions('some-lib', 'npm')).rejects.toThrow(
      /unsupported llm ecosystem/i
    );
  });

  it('filters out category-misaligned utilities for framework targets', async () => {
    const llmCandidates: LLMAlternativeCandidate[] = [
      { name: '@babel/helper-validator-identifier', description: 'Babel helper' },
      { name: 'remix', description: 'Full stack web framework' },
    ];

    const mockRegistry = {
      getPackageInfo: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'next') {
          return { name: 'next', description: 'React full-stack framework' };
        }
        if (name === 'remix') {
          return { name: 'remix', description: 'Full stack web framework' };
        }
        if (name === '@babel/helper-validator-identifier') {
          return { name: '@babel/helper-validator-identifier', description: 'Babel helper' };
        }
        throw new Error('not found');
      }),
      searchPackages: vi.fn().mockResolvedValue([]),
      getDownloadStats: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'remix') {
          return { weekly: 1_000_000, monthly: 0, total: 1_000_000 };
        }
        return { weekly: 10, monthly: 0, total: 10 };
      }),
    } as unknown as NpmRegistryClient;

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: 'openrouter',
      apiKey: 'test',
      outputChannel: createOutputChannel(),
      clientOverride: {
        generateAlternatives: vi.fn(async () => llmCandidates),
      },
    });

    const suggestions = await service.getSuggestions('next', 'pnpm', 'React framework');

    expect(suggestions.map((s) => s.name)).toEqual(['remix', '@babel/helper-validator-identifier']);
  });

  it('ranks compatible alternatives by weekly downloads', async () => {
    const llmCandidates: LLMAlternativeCandidate[] = [
      { name: 'lib-low', description: 'General purpose utility library' },
      { name: 'lib-high', description: 'General purpose utility library' },
    ];

    const mockRegistry = {
      getPackageInfo: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'target-lib') {
          return { name: 'target-lib', description: 'Useful utility library' };
        }
        if (name === 'lib-low' || name === 'lib-high') {
          return { name, description: 'General purpose utility library' };
        }
        throw new Error('not found');
      }),
      searchPackages: vi.fn().mockResolvedValue([]),
      getDownloadStats: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'lib-high') {
          return { weekly: 200_000, monthly: 0, total: 200_000 };
        }
        if (name === 'lib-low') {
          return { weekly: 1_000, monthly: 0, total: 1_000 };
        }
        return { weekly: 0, monthly: 0, total: 0 };
      }),
    } as unknown as NpmRegistryClient;

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: 'openrouter',
      apiKey: 'test',
      outputChannel: createOutputChannel(),
      clientOverride: {
        generateAlternatives: vi.fn(async () => llmCandidates),
      },
    });

    const suggestions = await service.getSuggestions('target-lib', 'npm', 'Useful utility library');

    expect(suggestions.map((s) => s.name)).toEqual(['lib-high', 'lib-low']);
  });

  it('drops invalid npm package names from LLM output', async () => {
    const llmCandidates: LLMAlternativeCandidate[] = [
      { name: '[  {', description: '' },
      { name: 'valid-lib', description: 'A valid utility library' },
    ];

    const mockRegistry = {
      getPackageInfo: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'target-lib') {
          return { name: 'target-lib', description: 'A utility library' };
        }
        if (name === 'valid-lib') {
          return { name: 'valid-lib', description: 'A valid utility library' };
        }
        throw new Error('not found');
      }),
      searchPackages: vi.fn().mockResolvedValue([]),
      getDownloadStats: vi.fn().mockResolvedValue({ weekly: 5_000, monthly: 0, total: 5_000 }),
    } as unknown as NpmRegistryClient;

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: 'openrouter',
      apiKey: 'test',
      outputChannel: createOutputChannel(),
      clientOverride: { generateAlternatives: vi.fn(async () => llmCandidates) },
    });

    const suggestions = await service.getSuggestions('target-lib', 'npm', 'A utility library');

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].name).toBe('valid-lib');
  });

  it('keeps only framework-like suggestions when target is a framework', async () => {
    const llmCandidates: LLMAlternativeCandidate[] = [
      { name: 'get-symbol-description', description: 'Symbol utility' },
      { name: 'p-reflect', description: 'Promise utility' },
      { name: 'remix', description: 'Full stack React web framework' },
      { name: 'nuxt', description: 'Vue meta framework for web apps' },
    ];

    const mockRegistry = {
      getPackageInfo: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'next') {
          return { name: 'next', description: 'React full-stack framework for web' };
        }
        if (name === 'remix') {
          return { name: 'remix', description: 'Full stack React web framework' };
        }
        if (name === 'nuxt') {
          return { name: 'nuxt', description: 'Vue meta framework for web apps' };
        }
        if (name === 'get-symbol-description') {
          return { name: 'get-symbol-description', description: 'Symbol utility' };
        }
        if (name === 'p-reflect') {
          return { name: 'p-reflect', description: 'Promise utility' };
        }
        throw new Error('not found');
      }),
      searchPackages: vi.fn().mockResolvedValue([]),
      getDownloadStats: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'nuxt') {
          return { weekly: 2_000_000, monthly: 0, total: 2_000_000 };
        }
        if (name === 'remix') {
          return { weekly: 1_000_000, monthly: 0, total: 1_000_000 };
        }
        return { weekly: 10, monthly: 0, total: 10 };
      }),
    } as unknown as NpmRegistryClient;

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: 'openrouter',
      apiKey: 'test',
      outputChannel: createOutputChannel(),
      clientOverride: { generateAlternatives: vi.fn(async () => llmCandidates) },
    });

    const suggestions = await service.getSuggestions('next', 'pnpm', 'React framework for web');

    // Framework targets now keep all validated candidates (no framework-tightening)
    expect(suggestions.map((s) => s.name)).toEqual(['nuxt', 'remix', 'get-symbol-description']);
  });

  it('falls back to known frameworks when LLM returns nothing usable', async () => {
    const llmCandidates: LLMAlternativeCandidate[] = [];

    const mockRegistry = {
      getPackageInfo: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'next') {
          return { name: 'next', description: 'React full-stack framework' };
        }
        return { name, description: `${name} framework` };
      }),
      searchPackages: vi.fn().mockResolvedValue([
        { name: 'nuxt', description: 'Vue meta framework', version: '1.0.0', downloads: 100 },
        { name: 'remix', description: 'Full stack framework', version: '1.0.0', downloads: 90 },
        {
          name: '@sveltejs/kit',
          description: 'SvelteKit framework',
          version: '1.0.0',
          downloads: 80,
        },
      ]),
      getDownloadStats: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'nuxt') return { weekly: 2_000_000, monthly: 0, total: 2_000_000 };
        if (name === 'remix') return { weekly: 1_500_000, monthly: 0, total: 1_500_000 };
        if (name === '@sveltejs/kit') return { weekly: 1_000_000, monthly: 0, total: 1_000_000 };
        return { weekly: 10, monthly: 0, total: 10 };
      }),
    } as unknown as NpmRegistryClient;

    const service = new LLMAlternativeSuggestionService(mockRegistry, {
      provider: 'openrouter',
      apiKey: 'test',
      outputChannel: createOutputChannel(),
      clientOverride: { generateAlternatives: vi.fn(async () => llmCandidates) },
    });

    const suggestions = await service.getSuggestions('next', 'pnpm', 'React framework');

    expect(suggestions).toEqual([]);
  });
});
