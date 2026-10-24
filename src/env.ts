import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  OAUTH_KV?: KVNamespace;
  // Injected by the OAuth provider for interactive authorization handlers.
  OAUTH_PROVIDER?: OAuthHelpers;
  API_TOKEN?: string;
  PUBLIC_URL?: string;
  DASHBOARD_ORIGIN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_OWNER_ID?: string;
}

export interface AuthProps {
  githubId: string;
  githubLogin: string;
}
