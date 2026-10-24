import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { api } from './api';
import { authorizedWithApiToken, oauthEnabled, publicOrigin } from './auth';
import type { Env } from './env';
import { handleError } from './errors';
import { getOAuthProvider } from './oauth';

export const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'no-store');
  await next();
});

app.use('*', bodyLimit({ maxSize: 64 * 1024 }));

app.use('*', async (c, next) => {
  const ownOrigin = publicOrigin(c.env) || new URL(c.req.url).origin;
  if (c.env.PUBLIC_URL && (!publicOrigin(c.env) || new URL(c.req.url).origin !== ownOrigin))
    return c.json({ error: 'Request origin does not match PUBLIC_URL' }, 400);
  const origin = c.req.header('Origin');
  if (origin && origin !== ownOrigin && origin !== c.env.DASHBOARD_ORIGIN)
    return c.json({ error: 'Origin not allowed' }, 403);
  return cors({
    origin: c.env.DASHBOARD_ORIGIN || ownOrigin,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version', 'Mcp-Session-Id'],
    exposeHeaders: ['Location', 'WWW-Authenticate'],
  })(c, next);
});

app.get('/health', (c) => c.json({ status: 'ok' }));

app.all('*', async (c) => {
  const protectedPath =
    c.req.path === '/mcp' || c.req.path.startsWith('/mcp/') || c.req.path.startsWith('/api/');
  if (protectedPath && (await authorizedWithApiToken(c.req.raw, c.env)))
    return api.fetch(c.req.raw, c.env, c.executionCtx);
  if (oauthEnabled(c.env))
    return getOAuthProvider(c.env).fetch(
      c.req.raw,
      c.env,
      // Hono exposes a narrower view of the actual Workers execution context.
      c.executionCtx as Parameters<ReturnType<typeof getOAuthProvider>['fetch']>[2],
    );
  if (protectedPath) {
    if (!c.env.API_TOKEN) return c.json({ error: 'Authentication is not configured' }, 503);
    c.header('WWW-Authenticate', 'Bearer realm="atlas"');
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (
    ['/authorize', '/auth/github/callback'].includes(c.req.path) ||
    c.req.path.startsWith('/oauth/')
  )
    return c.json({ error: 'GitHub OAuth is not configured' }, 503);
  return c.json({ error: 'Not found' }, 404);
});

app.onError(handleError);

export default {
  fetch(request, env, ctx) {
    // Accept the Worker origin as an MCP URL as well as /mcp. Forward internally
    // so clients keep their Authorization header and pass through the same checks.
    const url = new URL(request.url);
    if (url.pathname === '/') {
      url.pathname = '/mcp';
      request = new Request(url, request);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
