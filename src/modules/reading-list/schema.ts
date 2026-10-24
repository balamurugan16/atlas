import { z } from 'zod';

const text = z.string().trim().min(1).max(500);
const url = z
  .string()
  .url()
  .max(2048)
  .refine((v) => ['https:', 'http:'].includes(new URL(v).protocol), 'Must be an HTTP(S) URL');

const strings = z
  .array(text)
  .max(50)
  .transform((v) => [...new Set(v)]);

export const statusSchema = z.enum(['to_read', 'reading', 'finished', 'abandoned']);

const isbnSchema = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, '').toUpperCase())
  .refine((v) => {
    if (/^\d{13}$/.test(v))
      return [...v].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0;
    if (/^\d{9}[\dX]$/.test(v))
      return [...v].reduce((n, c, i) => n + (c === 'X' ? 10 : Number(c)) * (10 - i), 0) % 11 === 0;
    return false;
  }, 'Invalid ISBN checksum or format');

const fields = z
  .object({
    title: text,
    authors: strings,
    tags: strings,
    isbn: isbnSchema.nullable().optional(),
    description: z.string().trim().max(10000).nullable().optional(),
    coverUrl: url.nullable().optional(),
    sourceUrls: z.array(url).max(20),
    status: statusSchema,
    notes: z.string().trim().max(10000).nullable().optional(),
  })
  .strict();

export const bookSchema = fields.extend({
  authors: strings.default([]),
  tags: strings.default([]),
  sourceUrls: z.array(url).max(20).default([]),
  status: statusSchema.default('to_read'),
});

const unavailableReason = z.string().trim().min(10).max(1000);
const metadataUnavailableSchema = z
  .object({
    authors: unavailableReason.optional(),
    tags: unavailableReason.optional(),
    isbn: unavailableReason.optional(),
    description: unavailableReason.optional(),
    coverUrl: unavailableReason.optional(),
    sourceUrls: unavailableReason.optional(),
  })
  .strict();

// The MCP client researches metadata. Require it to account for every field
// rather than letting model omissions become silent nulls/default empty arrays.
export const mcpAddBookSchema = fields
  .extend({
    title: text.describe('The verified title of the book, matching the chosen edition.'),
    authors: strings.describe(
      'Verified author names. Do not omit. An empty array requires metadataUnavailable.authors.',
    ),
    tags: strings.describe(
      'A few useful genre/topic tags based on the verified book. Do not omit. An empty array requires metadataUnavailable.tags.',
    ),
    isbn: isbnSchema
      .nullable()
      .optional()
      .describe(
        'Optional ISBN-10 or ISBN-13 for the chosen edition. Include it only when known; otherwise omit it or use null. No unavailability explanation is required for ISBN.',
      ),
    description: z
      .string()
      .trim()
      .min(20)
      .max(10000)
      .nullable()
      .describe(
        'A useful book synopsis or description based on verified sources, preferably 2–5 sentences. Do not omit. Use null only if unavailable and explain in metadataUnavailable.description.',
      ),
    coverUrl: url
      .nullable()
      .describe(
        'A verified direct HTTP(S) URL to the cover image for this book/edition, not a search-results or book-detail page. Do not invent URLs. Use null only if unavailable and explain in metadataUnavailable.coverUrl.',
      ),
    sourceUrls: z
      .array(url)
      .max(20)
      .describe(
        'URLs of publisher/library/book-catalog sources used to verify the metadata. Do not omit. An empty array requires metadataUnavailable.sourceUrls.',
      ),
    status: statusSchema.default('to_read'),
    metadataUnavailable: metadataUnavailableSchema
      .optional()
      .describe(
        'Only for metadata that could not be verified after research. For each missing required field (ISBN is optional), explain what was checked and why the value is unavailable. Never use this to skip research. The save result reports these gaps to the user.',
      ),
  })
  .superRefine((book, ctx) => {
    const unavailable = book.metadataUnavailable || {};
    for (const field of [
      'authors',
      'tags',
      'isbn',
      'description',
      'coverUrl',
      'sourceUrls',
    ] as const) {
      const value = book[field];
      const missing =
        value === undefined || value === null || (Array.isArray(value) && value.length === 0);
      if (missing && field !== 'isbn' && !unavailable[field]) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `Research and supply ${field}, or explicitly explain why it could not be verified in metadataUnavailable.${field}.`,
        });
      }
      if (!missing && unavailable[field]) {
        ctx.addIssue({
          code: 'custom',
          path: ['metadataUnavailable', field],
          message: `${field} is present; remove its unavailability explanation.`,
        });
      }
    }
  });

export const updateSchema = fields
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');

const searchText = z.string().trim().min(1).max(500);
const filterValues = z
  .array(searchText)
  .min(1)
  .max(30)
  .transform((values) => [...new Set(values.map((value) => value.toLowerCase()))]);
const queryBoolean = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean(),
);
const searchField = z.enum(['title', 'authors', 'tags', 'description', 'notes', 'isbn']);

export const listSchema = z
  .object({
    status: statusSchema.optional().describe('Only books with this reading status.'),
    tag: searchText
      .optional()
      .describe(
        'One exact tag, ignoring case and surrounding whitespace. Prefer tags for multiple categories.',
      ),
    tags: filterValues
      .optional()
      .describe(
        'Exact tag values selected from list_book_values. Case-insensitive. Use tagsMatch=any for related categories such as programming, software engineering, and computer science.',
      ),
    tagsMatch: z
      .enum(['any', 'all'])
      .default('any')
      .describe('Whether a book needs any selected tag or all selected tags.'),
    author: searchText
      .optional()
      .describe('Literal case-insensitive substring of any author name.'),
    authors: filterValues
      .optional()
      .describe(
        'Any of these exact author names, ignoring case. Discover names using list_book_values.',
      ),
    title: searchText.optional().describe('Literal case-insensitive title substring.'),
    description: searchText.optional().describe('Literal case-insensitive description substring.'),
    notes: searchText.optional().describe('Literal case-insensitive notes substring.'),
    isbn: isbnSchema.optional().describe('An exact ISBN; spaces and hyphens are normalized.'),
    q: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Literal text search across searchFields. For a category request, discover and filter tags first rather than guessing from titles.',
      ),
    searchFields: z
      .array(searchField)
      .min(1)
      .max(6)
      .default(['title', 'authors', 'tags', 'description', 'notes', 'isbn'])
      .describe(
        'Fields searched by q. The term can match any selected field; other filters are combined with AND.',
      ),
    hasCover: queryBoolean
      .optional()
      .describe('true: only books with a cover URL; false: only books missing one.'),
    hasDescription: queryBoolean
      .optional()
      .describe('true: only books with a description; false: only books missing one.'),
    sortBy: z.enum(['createdAt', 'updatedAt', 'title']).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    view: z
      .enum(['summary', 'full'])
      .default('full')
      .describe(
        'summary returns compact book details; full also includes descriptions, covers, sources, and notes. Use get_book when one full record is needed.',
      ),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();

export const mcpListSchema = listSchema.extend({
  view: z
    .enum(['summary', 'full'])
    .default('summary')
    .describe(
      'Prefer summary for listings to avoid loading long book descriptions into context. Use full only when those details are requested.',
    ),
});

export const bookValuesSchema = z
  .object({
    field: z
      .enum(['tags', 'authors', 'status'])
      .describe(
        'Which stored values to discover. Use tags before category/genre/topic requests, authors before exact author filters.',
      ),
    q: searchText
      .optional()
      .describe(
        'Optional literal case-insensitive substring to narrow the vocabulary. Omit to discover all stored categories; category synonyms are not inferred by the database.',
      ),
    status: statusSchema
      .optional()
      .describe('Count values only among books with this reading status.'),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();

export type BookInput = z.infer<typeof bookSchema>;
export type BookUpdate = z.infer<typeof updateSchema>;
export type ListInput = z.infer<typeof listSchema>;
export type BookValuesInput = z.infer<typeof bookValuesSchema>;
