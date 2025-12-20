let githubTokenCache = '';

export function setGitHubToken(token: string): void {
  githubTokenCache = token;
}

export function getGitHubToken(): string {
  return githubTokenCache;
}
