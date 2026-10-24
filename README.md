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

Atlas is single-owner. It now hosts its own OAuth authorization server using `@cloudflare/workers-oauth-provider`. GitHub verifies your identity; Atlas issues the access and refresh tokens used by ChatGPT, Claude, or HTTP clients.

```text
Client → Atlas consent → GitHub sign-in → Atlas owner check → Client receives Atlas tokens
```

- **GitHub OAuth:** set `PUBLIC_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_OWNER_ID`, and bind `OAUTH_KV`. Only the configured numeric GitHub user ID can authorize access.
- **Personal bearer token:** optionally keep `API_TOKEN` for curl, scripts, or MCP clients with custom Authorization headers. It works even when GitHub is not configured. Never embed it in a deployed frontend bundle.

The old external-provider `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, `OAUTH_AUDIENCE`, and `OAUTH_OWNER_SUB` variables are no longer used. No Auth0, WorkOS, or other hosted authorization server is required.

OAuth grants use the `atlas` scope for full reading-list access through both transports. The canonical resource/audience is the **Worker origin**, e.g. `https://atlas.example.com`, while the MCP connection URL is `https://atlas.example.com/mcp`. Discovery advertises that distinction automatically.

Access tokens last one hour and refresh grants last 30 days. Refresh tokens rotate, with the immediately previous token accepted until its replacement is first used to allow retries. GitHub is used only during sign-in: its token is not retained, so revoking the GitHub app does not automatically revoke already-issued Atlas grants. Atlas supports RFC 7009 revocation at its advertised revocation endpoint (`/oauth/token`). Keep client tokens private.

Consent and GitHub state are short-lived, single-use, and bound to secure browser cookies. The callback always obtains the account ID from GitHub's authenticated `/user` API, rather than trusting a username or browser parameter. A change to `GITHUB_OWNER_ID` prevents existing grants for the old owner from accessing or refreshing.

### Configure GitHub and deploy

1. Pick your permanent Worker URL or custom-domain origin. Set `PUBLIC_URL` to that exact HTTPS origin, without a path. All requests must use that origin when it is configured.
2. Under **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**, create an app:

   | Setting                    | Value                                                  |
   | -------------------------- | ------------------------------------------------------ |
   | Application name           | Atlas                                                  |
   | Homepage URL               | `https://YOUR_WORKER.workers.dev`                      |
   | Authorization callback URL | `https://YOUR_WORKER.workers.dev/auth/github/callback` |

   Atlas requests no GitHub repository or email scopes; public profile identity is sufficient. Device flow is not used.
3. Find your numeric GitHub account ID from `https://api.github.com/users/YOUR_USERNAME` (the `id` field), or `gh api user --jq '.id'` if GitHub CLI is authenticated. Use this value for `GITHUB_OWNER_ID`, not your username.
4. Create the OAuth KV namespace:

   ```sh
   bunx wrangler login
   bunx wrangler kv namespace create OAUTH_KV
   ```

   Copy its ID over `REPLACE_WITH_OAUTH_KV_NAMESPACE_ID` in `wrangler.jsonc`. KV holds OAuth clients, consent/state transactions, grants, and token records. Your books remain in D1.
5. Configure non-secret Worker variables, either under **Cloudflare → Workers & Pages → atlas → Settings → Variables and Secrets** or by adding this top-level `vars` block to `wrangler.jsonc`:

   ```json
   "vars": {
     "PUBLIC_URL": "https://YOUR_WORKER.workers.dev",
     "GITHUB_OWNER_ID": "YOUR_NUMERIC_GITHUB_ID"
   }
   ```

   Set the GitHub credentials as secrets:

   ```sh
   bunx wrangler secret put GITHUB_CLIENT_ID
   bunx wrangler secret put GITHUB_CLIENT_SECRET
   # Optional direct access for scripts:
   bunx wrangler secret put API_TOKEN
   ```

   Do not paste the GitHub client secret into ChatGPT or commit it to Wrangler config.
6. Confirm your D1 ID is configured in `wrangler.jsonc`, apply production migrations, and deploy:

   ```sh
   # For a new database only: bunx wrangler d1 create atlas
   bun run db:migrate:remote
   bun run deploy
   ```

The checked-in `global_fetch_strictly_public` compatibility flag enables safe Client ID Metadata Document (CIMD) discovery. Dynamic client registration is also available for clients that use it. The consent page shows the requesting client and callback host before GitHub sign-in. Client registration alone does not grant access to your books.

### Connect an MCP client

Add `https://YOUR_WORKER.workers.dev/mcp` as a remote MCP server in ChatGPT or Claude and choose **OAuth**. Allow the requested Atlas access, sign in with the GitHub account matching `GITHUB_OWNER_ID`, and finish the connection. Atlas handles client registration/discovery; the GitHub OAuth App's credentials belong only in your Worker.

You can inspect these public discovery endpoints after deployment:

```text
/.well-known/oauth-authorization-server
/.well-known/oauth-protected-resource
```

A request without a token to `/mcp` must return `401` with a `WWW-Authenticate` header pointing to resource metadata. GitHub authorization is enabled only when all four variables and KV are configured. Without them, OAuth login returns `503`; personal-token access can still be used.

### Local development

The initial local setup above still works with just `API_TOKEN`. Wrangler supplies local D1 and KV storage, separate from production. You do not need real GitHub credentials to run the automated tests; they simulate GitHub's responses while exercising the complete OAuth flow in workerd.

For a manual local GitHub login, use a local HTTPS endpoint (for example `bun run dev --local-protocol https`) and set `PUBLIC_URL=https://localhost:8787` plus the three `GITHUB_*` values in `.dev.vars`. Register `https://localhost:8787/auth/github/callback` with a development GitHub OAuth App, and accept Wrangler's development certificate in your browser. Secure consent cookies require HTTPS; do not use plain HTTP for manual sign-in. To test from a hosted MCP client, use a deployed HTTPS Worker that the client can reach.

For a future React dashboard, use an OAuth public client with authorization code + S256 PKCE, the `atlas` scope, and the Worker origin as its resource. Set `DASHBOARD_ORIGIN` to the exact dashboard origin; cross-origin browser access is denied otherwise. No frontend is included yet.

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

Tests build a deployable bundle, start workerd through Miniflare, apply the real D1 migration to an isolated test database, and exercise HTTP/MCP interoperability, validation, duplicate ISBNs, pagination, GitHub owner restrictions, consent/state cookies, PKCE, OAuth discovery, token exchange, refresh/revocation, browser Origins, and authentication failures. GitHub and client-metadata responses are mocked; tests do not contact GitHub. They require permission to open local ports. No remote database or OAuth account is used.

## Layout

```text
src/index.ts                       Outer router and security middleware
src/api.ts                         Authenticated HTTP/MCP transport wiring
src/auth.ts                        Configuration and personal-token checks
src/oauth.ts                       Atlas OAuth authorization/token server
src/github.ts                      Consent, GitHub sign-in and owner check
src/mcp.ts                         MCP tool adapters
src/modules/reading-list/schema.ts Shared input contracts
src/modules/reading-list/service.ts D1 operations
src/modules/reading-list/http.ts   HTTP adapter
migrations/                        Versioned D1 schema
```

References: [Hono Workers guide](https://hono.dev/docs/getting-started/cloudflare-workers), [Cloudflare MCP handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), [OpenAI OAuth requirements](https://developers.openai.com/plugins/build/auth).
