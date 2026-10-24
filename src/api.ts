import { Hono } from 'hono';
import { createMcpHandler } from 'agents/mcp/server';
import type { Env } from './env';
import { publicOrigin } from './auth';
import { handleError } from './errors';
import { createServer } from './mcp';
import { readingListRoutes } from './modules/reading-list/http';

// Only called after the outer router or OAuth provider authenticates the request.
export const api = new Hono<{ Bindings: Env }>();
api.route('/api/v1/books', readingListRoutes);
api.all('/mcp', (c) =>
  createMcpHandler(() => createServer(c.env.DB), {
    route: '/mcp',
    corsOptions: false,
    // The outer router validates Origins before either authentication path.
    allowedOriginHostnames: '*',
    allowedHostnames: [new URL(publicOrigin(c.env) || c.req.url).hostname],
  }).fetch(c.req.raw),
);

api.notFound((c) => c.json({ error: 'Not found' }, 404));

api.onError(handleError);
