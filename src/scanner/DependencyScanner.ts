import type * as vscode from 'vscode';
import {
  type DependencyFile,
  DepPulseError,
  ErrorCode,
  type FileChange,
  type DependencyScanner as IDependencyScanner,
  type ProjectInfo,
} from '../types';

/**
 * Abstract base class for dependency scanners
 * Provides common functionality for scanning and parsing dependency files
 */
export abstract class BaseDependencyScanner implements IDependencyScanner {
  protected outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  /**
   * Scans the workspace for dependency files and returns project information
   */
  abstract scanWorkspace(): Promise<ProjectInfo>;

  /**
   * Parses a specific dependency file
   * @param filePath - Path to the dependency file
   */
  abstract parseDependencyFile(filePath: string): Promise<DependencyFile>;

  /**
   * Sets up file system watchers for dependency file changes
   * @param callback - Function to call when changes are detected
   */
  abstract watchForChanges(callback: (changes: FileChange[]) => void): vscode.Disposable;

  /**
   * Logs messages to the output channel with timestamp
   */
  protected log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    this.outputChannel.appendLine(logMessage);

    if (data) {
      this.outputChannel.appendLine(JSON.stringify(data, null, 2));
    }
  }

  /**
   * Handles errors during scanning operations
   */
  protected handleError(error: unknown, context: string): DepPulseError {
    if (error instanceof DepPulseError) {
      return error;
    }

    let code = ErrorCode.UNKNOWN;
    let recoverable = false;
    let errorMessage = 'Unknown error';

    if (this.isNodeError(error) && error.code === 'ENOENT') {
      code = ErrorCode.FILE_NOT_FOUND;
      recoverable = true;
      errorMessage = error.message;
    } else if (error instanceof SyntaxError) {
      code = ErrorCode.PARSE_ERROR;
      recoverable = true;
      errorMessage = error.message;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    const depPulseError = new DepPulseError(`${context}: ${errorMessage}`, code, recoverable, {
      originalError: error,
    });

    this.log('error', depPulseError.message, { code, recoverable });
    return depPulseError;
  }

  /**
   * Type guard to check if error is a Node.js error with code property
   */
  protected isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === 'object' && error !== null && 'code' in error;
  }
}
