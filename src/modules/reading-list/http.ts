import { Hono } from 'hono';
import type { Env } from '../../env';
import { bookSchema, listSchema, updateSchema } from './schema';
import { ReadingList } from './service';

export const readingListRoutes = new Hono<{ Bindings: Env }>();

readingListRoutes.get('/', async (c) =>
  c.json(await new ReadingList(c.env.DB).list(listSchema.parse(c.req.query()))),
);

readingListRoutes.get('/:id', async (c) =>
  c.json(await new ReadingList(c.env.DB).get(c.req.param('id'))),
);

readingListRoutes.post('/', async (c) => {
  const input = bookSchema.parse(await c.req.json());
  const book = await new ReadingList(c.env.DB).add(input);
  c.header('Location', `/api/v1/books/${book.id}`);
  return c.json(book, 201);
});

readingListRoutes.patch('/:id', async (c) =>
  c.json(
    await new ReadingList(c.env.DB).update(
      c.req.param('id'),
      updateSchema.parse(await c.req.json()),
    ),
  ),
);

readingListRoutes.delete('/:id', async (c) => {
  await new ReadingList(c.env.DB).remove(c.req.param('id'));
  return c.body(null, 204);
});
