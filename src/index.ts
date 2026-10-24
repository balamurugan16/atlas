import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { ZodError } from 'zod';
import { createMcpHandler } from 'agents/mcp/server';
import type { Env } from './env';
import { authorized, oauthEnabled } from './auth';
import { createServer } from './mcp';
import { readingListRoutes } from './modules/reading-list/http';
import { BookError } from './modules/reading-list/service';

export const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'no-store');
  await next();
});
app.use('*', bodyLimit({ maxSize: 64 * 1024 }));
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  const ownOrigin = c.env.PUBLIC_URL ? new URL(c.env.PUBLIC_URL).origin : new URL(c.req.url).origin;
  if (origin && origin !== ownOrigin && origin !== c.env.DASHBOARD_ORIGIN)
    return c.json({ error: 'Origin not allowed' }, 403);
  return cors({
    origin: c.env.DASHBOARD_ORIGIN || ownOrigin,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version', 'Mcp-Session-Id'],
    exposeHeaders: ['Location'],
  })(c, next);
});
app.get('/health', (c) => c.json({ status: 'ok' }));
const metadata = (env: Env) => ({
  resource: env.OAUTH_AUDIENCE,
  authorization_servers: [env.OAUTH_ISSUER],
  scopes_supported: ['atlas'],
  bearer_methods_supported: ['header'],
});
for (const path of [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
]) {
  app.get(path, (c) =>
    oauthEnabled(c.env)
      ? c.json(metadata(c.env))
      : c.json({ error: 'OAuth is not configured' }, 404),
  );
}
app.use('/api/*', protect);
app.use('/mcp', protect);
async function protect(c: import('hono').Context<{ Bindings: Env }>, next: import('hono').Next) {
  if (!c.env.API_TOKEN && !oauthEnabled(c.env))
    return c.json({ error: 'Authentication is not configured' }, 503);
  if (!(await authorized(c.req.raw, c.env))) {
    const base = c.env.PUBLIC_URL || new URL(c.req.url).origin;
    c.header(
      'WWW-Authenticate',
      oauthEnabled(c.env)
        ? `Bearer resource_metadata="${base.replace(/\/$/, '')}/.well-known/oauth-protected-resource", scope="atlas"`
        : 'Bearer realm="atlas"',
    );
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
}
app.route('/api/v1/books', readingListRoutes);
app.all('/mcp', (c) =>
  createMcpHandler(() => createServer(c.env.DB), {
    route: '/mcp',
    corsOptions: false,
    // Origin validation has already run above, including malformed/opaque Origins.
    allowedOriginHostnames: '*',
    allowedHostnames: [new URL(c.env.PUBLIC_URL || c.req.url).hostname],
  }).fetch(c.req.raw),
);
app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((error, c) => {
  if (error instanceof ZodError)
    return c.json({ error: 'Validation failed', issues: error.issues }, 400);
  if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON body' }, 400);
  if (error instanceof BookError) return c.json({ error: error.message }, error.status);
  console.error('Request failed', error);
  return c.json({ error: 'Internal server error' }, 500);
});
export default app;
