import OAuthProvider, {
  OAuthError,
  insufficientScope,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { api } from './api';
import { publicOrigin } from './auth';
import type { AuthProps, Env } from './env';
import { githubAuth } from './github';

let cached: { origin: string; provider: OAuthProvider<Env> } | undefined;

export function getOAuthProvider(env: Env): OAuthProvider<Env> {
  const origin = publicOrigin(env)!;
  if (cached?.origin === origin) return cached.provider;
  const provider = new OAuthProvider<Env>({
    // The canonical resource is the whole personal API, covering both transports.
    resourceMetadata: { resource: origin, authorization_servers: [origin], resource_name: 'Atlas' },
    apiRoute: ['/mcp', '/api/'],
    apiHandler: {
      fetch(request, env, context) {
        const ctx = context as OAuthResourceContext<AuthProps>;
        if (ctx.props?.githubId !== env.GITHUB_OWNER_ID || ctx.auth?.userId !== env.GITHUB_OWNER_ID)
          return Response.json(
            { error: 'This account does not own this reading list' },
            { status: 403 },
          );
        if (!ctx.auth.scope.includes('atlas')) return insufficientScope(ctx.auth, ['atlas']);
        return api.fetch(request, env, context);
      },
    },
    defaultHandler: { fetch: (request, env, ctx) => githubAuth.fetch(request, env, ctx) },
    authorizeEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/oauth/token`,
    clientRegistrationEndpoint: `${origin}/oauth/register`,
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ['atlas', 'offline_access'],
    requiredScopes: ['atlas'],
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    clientRegistrationTTL: 90 * 24 * 60 * 60,
    tokenExchangeCallback({ userId, props, env }) {
      if (userId !== env.GITHUB_OWNER_ID || props?.githubId !== env.GITHUB_OWNER_ID)
        throw new OAuthError('invalid_grant', {
          description: 'The owner of this reading list has changed.',
        });
      return Promise.resolve();
    },
    onError({ code, status }) {
      console.warn('OAuth request rejected', { code, status });
    },
  });
  cached = { origin, provider };
  return provider;
}
