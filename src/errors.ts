import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import type { Env } from './env';
import { BookError } from './modules/reading-list/service';

export const handleError: ErrorHandler<{ Bindings: Env }> = (error, c) => {
  if (error instanceof ZodError)
    return c.json({ error: 'Validation failed', issues: error.issues }, 400);
  if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON body' }, 400);
  if (error instanceof BookError) return c.json({ error: error.message }, error.status);
  console.error('Request failed', error);
  return c.json({ error: 'Internal server error' }, 500);
};
