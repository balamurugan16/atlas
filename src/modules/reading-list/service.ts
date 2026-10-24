import type { BookInput, BookUpdate, BookValuesInput, ListInput } from './schema';

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
      where.push(
        'EXISTS (SELECT 1 FROM json_each(books.tags) WHERE lower(trim(value)) = lower(trim(?)))',
      );
      args.push(input.tag);
    }
    if (input.tags) {
      const placeholders = input.tags.map(() => '?').join(', ');
      const matches = `SELECT DISTINCT lower(trim(value)) FROM json_each(books.tags) WHERE lower(trim(value)) IN (${placeholders})`;
      where.push(
        input.tagsMatch === 'all'
          ? `(SELECT COUNT(*) FROM (${matches})) = ?`
          : `EXISTS (${matches})`,
      );
      args.push(...input.tags);
      if (input.tagsMatch === 'all') args.push(input.tags.length);
    }
    if (input.authors) {
      where.push(
        `EXISTS (SELECT 1 FROM json_each(books.authors) WHERE lower(trim(value)) IN (${input.authors.map(() => '?').join(', ')}))`,
      );
      args.push(...input.authors);
    }
    if (input.author) {
      where.push(
        'EXISTS (SELECT 1 FROM json_each(books.authors) WHERE instr(lower(value), lower(?)) > 0)',
      );
      args.push(input.author);
    }
    for (const field of ['title', 'description', 'notes'] as const) {
      if (input[field]) {
        where.push(`instr(lower(coalesce(${field}, '')), lower(?)) > 0`);
        args.push(input[field]!);
      }
    }
    if (input.isbn) {
      where.push('isbn = ?');
      args.push(input.isbn);
    }
    for (const [field, value] of [
      ['cover_url', input.hasCover],
      ['description', input.hasDescription],
    ] as const) {
      if (value !== undefined)
        where.push(`length(trim(coalesce(${field}, ''))) ${value ? '>' : '='} 0`);
    }
    if (input.q) {
      // Only these fixed expressions can enter SQL; all user values are bound.
      const expressions = {
        title: "instr(lower(coalesce(title, '')), lower(?)) > 0",
        authors:
          'EXISTS (SELECT 1 FROM json_each(books.authors) WHERE instr(lower(value), lower(?)) > 0)',
        tags: 'EXISTS (SELECT 1 FROM json_each(books.tags) WHERE instr(lower(value), lower(?)) > 0)',
        description: "instr(lower(coalesce(description, '')), lower(?)) > 0",
        notes: "instr(lower(coalesce(notes, '')), lower(?)) > 0",
        isbn: "instr(coalesce(isbn, ''), replace(replace(?, '-', ''), ' ', '')) > 0",
      };
      where.push('(' + input.searchFields.map((field) => expressions[field]).join(' OR ') + ')');
      args.push(...input.searchFields.map(() => input.q!));
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sort = {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      title: 'title COLLATE NOCASE',
    }[input.sortBy];
    const direction = input.order === 'asc' ? 'ASC' : 'DESC';
    const [count, page] = await this.db.batch([
      this.db.prepare(`SELECT COUNT(*) AS total FROM books ${clause}`).bind(...args),
      this.db
        .prepare(
          `SELECT * FROM books ${clause} ORDER BY ${sort} ${direction}, id ${direction} LIMIT ? OFFSET ?`,
        )
        .bind(...args, input.limit, input.offset),
    ]);
    const total = (count.results[0] as { total: number }).total;
    const items = (page.results as Row[]).map(decode).map((book) =>
      input.view === 'summary'
        ? {
            id: book.id,
            title: book.title,
            authors: book.authors,
            tags: book.tags,
            status: book.status,
            isbn: book.isbn,
            hasCover: !!book.coverUrl?.trim(),
            hasDescription: !!book.description?.trim(),
          }
        : book,
    );
    return {
      items,
      total,
      nextOffset: input.offset + items.length < total ? input.offset + items.length : null,
    };
  }

  async values(input: BookValuesInput) {
    const expression = input.field === 'status' ? 'books.status' : 'entry.value';
    const from =
      input.field === 'status'
        ? 'books'
        : `books, json_each(books.${input.field === 'tags' ? 'tags' : 'authors'}) AS entry`;
    const where = [`length(trim(${expression})) > 0`];
    const args: string[] = [];
    if (input.status) {
      where.push('books.status = ?');
      args.push(input.status);
    }
    if (input.q) {
      where.push(`instr(lower(${expression}), lower(?)) > 0`);
      args.push(input.q);
    }
    const grouped = `SELECT MIN(trim(${expression})) AS value, COUNT(DISTINCT books.id) AS count FROM ${from} WHERE ${where.join(' AND ')} GROUP BY lower(trim(${expression}))`;
    const [count, page] = await this.db.batch([
      this.db.prepare(`SELECT COUNT(*) AS total FROM (${grouped})`).bind(...args),
      this.db
        .prepare(`${grouped} ORDER BY count DESC, value COLLATE NOCASE ASC LIMIT ? OFFSET ?`)
        .bind(...args, input.limit, input.offset),
    ]);
    const total = (count.results[0] as { total: number }).total;
    const items = page.results as { value: string; count: number }[];
    return {
      field: input.field,
      items,
      total,
      nextOffset: input.offset + items.length < total ? input.offset + items.length : null,
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
