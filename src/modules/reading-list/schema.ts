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

export const updateSchema = fields
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');

export const listSchema = z
  .object({
    status: statusSchema.optional(),
    tag: text.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();

export type BookInput = z.infer<typeof bookSchema>;
export type BookUpdate = z.infer<typeof updateSchema>;
export type ListInput = z.infer<typeof listSchema>;
