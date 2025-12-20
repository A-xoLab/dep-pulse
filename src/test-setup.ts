import { vi } from 'vitest';

/**
 * Get the number of iterations for property-based tests
 * Uses FAST_TESTS environment variable to reduce iterations for faster test runs
 * @param defaultRuns Default number of runs when not in fast mode
 * @param fastRuns Number of runs when FAST_TESTS=true
 * @returns Number of iterations to use
 */
export function getPropertyTestRuns(defaultRuns: number, fastRuns: number = 10): number {
  const isFastMode = process.env.FAST_TESTS === 'true';
  return isFastMode ? fastRuns : defaultRuns;
}

// Mock vscode module globally for all tests
vi.mock('vscode', () => ({
  window: {
    createWebviewPanel: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    createOutputChannel: vi.fn(),
    terminals: [],
    createTerminal: vi.fn(),
  },
  ViewColumn: {
    One: 1,
    Two: 2,
    Three: 3,
  },
  Uri: {
    joinPath: vi.fn((base, ...paths) => ({
      scheme: 'file',
      authority: '',
      path: `${base.path}/${paths.join('/')}`,
      query: '',
      fragment: '',
      fsPath: `${base.path}/${paths.join('/')}`,
      with: vi.fn(),
      toJSON: vi.fn(),
    })),
    file: vi.fn((path) => ({
      scheme: 'file',
      authority: '',
      path,
      query: '',
      fragment: '',
      fsPath: path,
      with: vi.fn(),
      toJSON: vi.fn(),
    })),
  },
  workspace: {
    workspaceFolders: [],
    fs: {
      stat: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
    },
    getConfiguration: vi.fn(() => ({
      get: vi.fn(),
      has: vi.fn(),
      inspect: vi.fn(),
      update: vi.fn(),
    })),
    findFiles: vi.fn(),
    onDidChangeConfiguration: vi.fn(),
    openTextDocument: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: vi.fn(),
  },
  env: {
    openExternal: vi.fn(),
  },
}));
