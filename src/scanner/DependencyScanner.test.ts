import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { type DependencyFile, DepPulseError, ErrorCode, type ProjectInfo } from '../types';
import { BaseDependencyScanner } from './DependencyScanner';

const outputChannelMock: vscode.OutputChannel = {
  name: 'DepPulse Test',
  append: vi.fn(),
  appendLine: vi.fn(),
  clear: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  replace: vi.fn(),
  dispose: vi.fn(),
};

class TestScanner extends BaseDependencyScanner {
  // Minimal implementations to satisfy the abstract interface – not used in these tests
  async scanWorkspace(): Promise<ProjectInfo> {
    return { type: [], dependencyFiles: [], dependencies: [] };
  }

  async parseDependencyFile(): Promise<DependencyFile> {
    throw new Error('not implemented');
  }

  watchForChanges(): vscode.Disposable {
    return { dispose: () => {} };
  }

  // Expose protected helpers for testing
  public handle(error: unknown, context: string): DepPulseError {
    // Access protected method for testing
    return (
      this as unknown as { handleError: (error: unknown, context: string) => DepPulseError }
    ).handleError(error, context);
  }

  public asNodeError(error: unknown): boolean {
    // Access protected method for testing
    return (this as unknown as { isNodeError: (error: unknown) => boolean }).isNodeError(error);
  }
}

describe('BaseDependencyScanner', () => {
  it('wraps ENOENT errors as recoverable FILE_NOT_FOUND', () => {
    const scanner = new TestScanner(outputChannelMock);
    const nodeError = Object.assign(new Error('no such file or directory'), {
      code: 'ENOENT',
    });

    const result = scanner.handle(nodeError, 'reading package.json');

    expect(result).toBeInstanceOf(DepPulseError);
    expect(result.code).toBe(ErrorCode.FILE_NOT_FOUND);
    expect(result.recoverable).toBe(true);
    expect(result.message).toContain('reading package.json');
    expect(outputChannelMock.appendLine).toHaveBeenCalled();
  });

  it('wraps SyntaxError as recoverable PARSE_ERROR', () => {
    const scanner = new TestScanner(outputChannelMock);
    const syntaxError = new SyntaxError('Unexpected token');

    const result = scanner.handle(syntaxError, 'parsing lockfile');

    expect(result.code).toBe(ErrorCode.PARSE_ERROR);
    expect(result.recoverable).toBe(true);
  });

  it('detects NodeJS style errors in isNodeError guard', () => {
    const scanner = new TestScanner(outputChannelMock);
    const nodeError = Object.assign(new Error('fail'), { code: 'EFAIL' });

    expect(scanner.asNodeError(nodeError)).toBe(true);
    expect(scanner.asNodeError(new Error('plain error'))).toBe(false);
    expect(scanner.asNodeError(null)).toBe(false);
    expect(scanner.asNodeError({})).toBe(false);
  });
});
