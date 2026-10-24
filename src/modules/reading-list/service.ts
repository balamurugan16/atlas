import type { BookInput, BookUpdate, ListInput } from './schema';

export class BookError extends Error {
  constructor(
    message: string,
    public status: 404 | 409,
  ) {
    super(message);
  }
}

type Row = {
  id: string;
  title: string;
  authors: string;
  tags: string;
  isbn: string | null;
  description: string | null;
  cover_url: string | null;
  source_urls: string;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

function decode(r: Row) {
  return {
    id: r.id,
    title: r.title,
    authors: JSON.parse(r.authors) as string[],
    tags: JSON.parse(r.tags) as string[],
    isbn: r.isbn,
    description: r.description,
    coverUrl: r.cover_url,
    sourceUrls: JSON.parse(r.source_urls) as string[],
    status: r.status,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ReadingList {
  constructor(private db: D1Database) {}

  async get(id: string) {
    const row = await this.db.prepare('SELECT * FROM books WHERE id = ?').bind(id).first<Row>();
    if (!row) throw new BookError('Book not found', 404);
    return decode(row);
  }

  async list(input: ListInput) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (input.status) {
      where.push('status = ?');
      args.push(input.status);
    }
    if (input.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(books.tags) WHERE value = ?)');
      args.push(input.tag);
    }
    if (input.q) {
      where.push(
        '(instr(lower(title), lower(?)) > 0 OR EXISTS (SELECT 1 FROM json_each(books.authors) WHERE instr(lower(value), lower(?)) > 0))',
      );
      args.push(input.q, input.q);
    }
    const result = await this.db
      .prepare(
        `SELECT * FROM books ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...args, input.limit + 1, input.offset)
      .all<Row>();
    return {
      items: result.results.slice(0, input.limit).map(decode),
      nextOffset: result.results.length > input.limit ? input.offset + input.limit : null,
    };
  }

  async add(book: BookInput) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await this.db
        .prepare(
          'INSERT INTO books (id,title,authors,tags,isbn,description,cover_url,source_urls,status,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          id,
          book.title,
          JSON.stringify(book.authors),
          JSON.stringify(book.tags),
          book.isbn ?? null,
          book.description ?? null,
          book.coverUrl ?? null,
          JSON.stringify(book.sourceUrls),
          book.status,
          book.notes ?? null,
          now,
          now,
        )
        .run();
    } catch (e) {
      this.handleConstraint(e);
    }
    return this.get(id);
  }

  async update(id: string, book: BookUpdate) {
    const columns: Record<string, string> = {
      title: 'title',
      authors: 'authors',
      tags: 'tags',
      isbn: 'isbn',
      description: 'description',
      coverUrl: 'cover_url',
      sourceUrls: 'source_urls',
      status: 'status',
      notes: 'notes',
    };
    const entries = Object.entries(book).filter(([, v]) => v !== undefined);
    const values = entries.map(([k, v]) =>
      ['authors', 'tags', 'sourceUrls'].includes(k) ? JSON.stringify(v) : (v as string | null),
    );
    try {
      const row = await this.db
        .prepare(
          `UPDATE books SET ${entries.map(([k]) => columns[k] + ' = ?').join(', ')}, updated_at = ? WHERE id = ? RETURNING *`,
        )
        .bind(...values, new Date().toISOString(), id)
        .first<Row>();
      if (!row) throw new BookError('Book not found', 404);
      return decode(row);
    } catch (e) {
      this.handleConstraint(e);
    }
  }

  async remove(id: string) {
    const result = await this.db.prepare('DELETE FROM books WHERE id = ?').bind(id).run();
    if (!result.meta.changes) throw new BookError('Book not found', 404);
    return { deleted: true, id };
  }

  private handleConstraint(e: unknown): never {
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed: books.isbn'))
      throw new BookError('A book with this ISBN already exists', 409);
    throw e;
  }
}
