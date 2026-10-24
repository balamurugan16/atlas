export interface Env {
  DB: D1Database;
  API_TOKEN?: string;
  PUBLIC_URL?: string;
  DASHBOARD_ORIGIN?: string;
  OAUTH_ISSUER?: string;
  OAUTH_JWKS_URL?: string;
  OAUTH_AUDIENCE?: string;
  OAUTH_OWNER_SUB?: string;
}
