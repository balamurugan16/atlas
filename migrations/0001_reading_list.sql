CREATE TABLE books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(authors)),
  tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags)),
  isbn TEXT UNIQUE,
  description TEXT,
  cover_url TEXT,
  source_urls TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_urls)),
  status TEXT NOT NULL DEFAULT 'to_read' CHECK(status IN ('to_read','reading','finished','abandoned')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX books_status_created ON books(status, created_at DESC, id DESC);
CREATE INDEX books_created ON books(created_at DESC, id DESC);
