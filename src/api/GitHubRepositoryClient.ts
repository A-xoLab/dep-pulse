import type * as vscode from 'vscode';
import { BaseAPIClient } from './APIClient';

interface GitHubRepoResponse {
  archived: boolean;
  full_name: string;
}

/**
 * Lightweight client for fetching repository metadata from GitHub
 * Primarily used to detect archived projects for maintenance signals.
 */
export class GitHubRepositoryClient extends BaseAPIClient {
  constructor(outputChannel: vscode.OutputChannel, githubToken?: string) {
    super('https://api.github.com', outputChannel);

    if (githubToken) {
      this.axiosInstance.defaults.headers.common.Authorization = `Bearer ${githubToken}`;
    }
  }

  /**
   * Fetch repository metadata using an owner/repo tuple.
   */
  async getRepository(owner: string, repo: string): Promise<{ archived: boolean } | null> {
    try {
      const response = await this.axiosInstance.get<GitHubRepoResponse>(`/repos/${owner}/${repo}`);
      return {
        archived: response.data.archived,
      };
    } catch (error) {
      this.log('warn', `Failed to fetch repo metadata for ${owner}/${repo}`, error);
      return null;
    }
  }

  /**
   * Convenience method to fetch metadata directly from a repository URL.
   */
  async getRepositoryFromUrl(
    repoUrl: string | undefined | null
  ): Promise<{ archived: boolean } | null> {
    if (!repoUrl) {
      return null;
    }

    const parsed = this.extractOwnerRepo(repoUrl);
    if (!parsed) {
      return null;
    }

    return this.getRepository(parsed.owner, parsed.repo);
  }

  private extractOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
    let normalized = repoUrl.trim();
    normalized = normalized.replace(/^git\+/, '');
    normalized = normalized.replace(/\.git$/, '');

    const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/(.+)$/i);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    try {
      const url = new URL(normalized);
      if (url.hostname !== 'github.com') {
        return null;
      }

      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length < 2) {
        return null;
      }

      return {
        owner: segments[0],
        repo: segments[1],
      };
    } catch {
      return null;
    }
  }
}
