# Atlas

A personal API built with Hono, TypeScript, Cloudflare Workers and D1. Bun manages dependencies and development commands; the deployed API runs in **workerd**, not Bun.

`/api/v1/books` and `/mcp` share one reading-list service and Zod schemas. Adding future modules means adding a service, HTTP routes, MCP tools, and a D1 migration.

## Local setup

```sh
bun install
cp .dev.vars.example .dev.vars
# Replace API_TOKEN in .dev.vars with a random secret (e.g. openssl rand -hex 32).
bun run db:migrate:local
bun run dev
```

Wrangler supplies a local D1 database and runs the Worker at `http://localhost:8787`. Local migrations do not affect production. `.dev.vars` is ignored by Git.

```sh
curl http://localhost:8787/api/v1/books \
  -H "Authorization: Bearer $ATLAS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"A Wizard of Earthsea","authors":["Ursula K. Le Guin"],"tags":["fantasy"],"status":"to_read"}'

curl http://localhost:8787/api/v1/books?status=to_read \
  -H "Authorization: Bearer $ATLAS_TOKEN"
```

`ATLAS_TOKEN` in these examples must match `API_TOKEN` in `.dev.vars`.

## Reading list

Fields: `title` (required), `authors`, `tags`, `isbn`, `description`, `coverUrl`, `sourceUrls`, `status`, `notes`. The server generates `id`, `createdAt` and `updatedAt`. Status is `to_read`, `reading`, `finished`, or `abandoned`.

ISBNs are normalized and checksum validated. Duplicate ISBNs return HTTP 409. Books without ISBNs can have duplicate titles: different editions may share a title. Use search before adding. Cover images are stored as URLs; Atlas does not download images or verify ownership/availability of remote URLs.

| HTTP                       | MCP tool      | Behavior               |
| -------------------------- | ------------- | ---------------------- |
| `POST /api/v1/books`       | `add_book`    | Add supplied metadata  |
| `GET /api/v1/books`        | `list_books`  | Search and filter      |
| `GET /api/v1/books/:id`    | `get_book`    | Retrieve book          |
| `PATCH /api/v1/books/:id`  | `update_book` | Update supplied fields |
| `DELETE /api/v1/books/:id` | `delete_book` | Permanently delete     |

List accepts `q` (literal case-insensitive title/author search), `tag` (exact match), `status`, `limit` (1–100, default 25), and `offset` (default 0). Results are `{items, nextOffset}`. Ordering is newest first with ID as a tie breaker. Offset pagination is suitable for a personal list; concurrent inserts may move page boundaries.

PATCH leaves omitted fields alone, replaces arrays, and accepts `null` for ISBN, description, cover URL and notes. Unknown fields and empty updates are rejected. Request bodies are limited to 64 KiB. HTTP failures return `{error}`; validation failures also include `issues`. MCP domain errors use `isError`.

## ChatGPT and Claude

The remote MCP endpoint is `https://YOUR_WORKER/mcp`, using Streamable HTTP with stateless compatibility for legacy clients. Each request creates a server; D1 persists all data. There are no Durable Objects or MCP session storage requirements.

The intended workflow is: “Research this book and add it to my reading list.” The MCP instructions ask the client to research reliable sources, pass verified metadata, include source URLs, and omit unknown details. **The client must have browsing/search tools available.** An MCP connection alone does not give a model web access. Atlas itself has no LLM or web-search dependency and needs no OpenAI or Anthropic API key.

### Authentication

Atlas is single-owner. Both transports fail closed when authentication is unconfigured.

- **Personal bearer token:** set `API_TOKEN` for curl, scripts, or MCP clients that support custom Authorization headers. Do not embed this token in a deployed React bundle.
- **OAuth:** configure the four `OAUTH_*` variables from `.dev.vars.example`, plus `PUBLIC_URL`. Atlas verifies RS256/ES256 JWT access tokens against your authorization server's JWKS, checking signature, issuer, audience, expiry, exact owner subject, and the `atlas` scope. Tokens from other users are rejected.

Atlas implements the **OAuth protected resource**, not an authorization server. To connect private data through ChatGPT/Claude, configure an external OAuth provider that supports the client's registration flow (dynamic registration/client metadata or a pre-registered client), authorization code with PKCE, and JWT access tokens for this API. Configure consent/access for your own account and grant the `atlas` scope. Set the API audience to your canonical `https://YOUR_WORKER/mcp` URL. The provider must expose OAuth authorization-server discovery metadata. Use its documented setup for the chosen client; do not select “no authentication” for this private API.

Atlas publishes `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, and advertises resource discovery in 401 responses. OAuth provider provisioning, client registration, and real ChatGPT/Claude sign-in require your account configuration and are not performed by this repository.

For a future React dashboard, use an OAuth public client with authorization code + PKCE and short-lived access tokens. Set `DASHBOARD_ORIGIN` to its exact origin; cross-origin browser access is denied otherwise. CORS is not authentication. All OAuth tokens currently grant full reading-list access with a single `atlas` scope.

## Deploy

```sh
bunx wrangler login
bunx wrangler d1 create atlas
# Copy the returned database_id into wrangler.jsonc.
bun run db:migrate:remote
bunx wrangler secret put API_TOKEN
# Configure PUBLIC_URL and OAuth variables in Wrangler/Cloudflare if using OAuth.
bun run deploy
```

Set `PUBLIC_URL` to the canonical HTTPS Worker/custom-domain origin (no trailing path). Keep `OAUTH_AUDIENCE` consistent with the OAuth provider's API audience. Never commit tokens. No Cloudflare resources are created automatically by installing or building this project.

## Formatting

Biome formats the source, tests, and supported configuration files with two-space indentation, single quotes in JavaScript/TypeScript, and a 100-column line width. Generated files and dependencies are excluded. Linting and assist actions are disabled so this configuration only formats files.

```sh
bun run format        # Apply formatting
bun run format:check  # Check formatting without writing (suitable for CI)
```

## Validation

```sh
bun run typecheck
bun run test
```

Tests build a deployable bundle, start workerd through Miniflare, apply the real D1 migration to an isolated test database, and exercise HTTP/MCP interoperability, validation, duplicate ISBNs, pagination, OAuth verification, owner restrictions, browser Origins, and authentication failures. They require permission to open local ports. No remote database or OAuth account is used.

## Layout

```text
src/index.ts                       Hono app, middleware, transport wiring
src/auth.ts                        Bearer/JWT verification
src/mcp.ts                         MCP tool adapters
src/modules/reading-list/schema.ts Shared input contracts
src/modules/reading-list/service.ts D1 operations
src/modules/reading-list/http.ts   HTTP adapter
migrations/                        Versioned D1 schema
```

References: [Hono Workers guide](https://hono.dev/docs/getting-started/cloudflare-workers), [Cloudflare MCP handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), [OpenAI OAuth requirements](https://developers.openai.com/plugins/build/auth).
