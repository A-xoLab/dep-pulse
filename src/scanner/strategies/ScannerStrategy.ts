import type { ProjectInfo } from '../../types';

export interface ScannerStrategy {
  /**
   * Scans the given path (workspace folder) for dependencies
   * @param path Absolute path to the workspace folder
   */
  scan(path: string): Promise<ProjectInfo>;

  /**
   * Returns the name of the strategy for logging
   */
  getName(): string;
}
