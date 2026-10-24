import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createHash, randomUUID } from 'node:crypto';

let mf;
const githubExchanges = new Map(),
  githubUsers = new Map(),
  clientDocuments = new Map();
const outboundFailures = [];
const secret = 'test-only-personal-token';
const base = 'https://atlas.example';
const ownerId = '12345';
const clientRedirect = 'https://client.example/callback';
before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: 'dist/index.js',
    compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    upstream: base,
    d1Databases: ['DB'],
    kvNamespaces: ['OAUTH_KV'],
    outboundService: mockOutbound,
    bindings: {
      API_TOKEN: secret,
      PUBLIC_URL: base,
      DASHBOARD_ORIGIN: 'https://dashboard.example',
      GITHUB_CLIENT_ID: 'test-github-client',
      GITHUB_CLIENT_SECRET: 'test-github-secret',
      GITHUB_OWNER_ID: ownerId,
    },
  });
  const db = await mf.getD1Database('DB');
  const sql = await readFile('migrations/0001_reading_list.sql', 'utf8');
  await db.batch(
    sql
      .split(';')
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
});
after(async () => {
  await mf?.dispose();
  assert.deepEqual(outboundFailures, []);
});
async function request(path, method = 'GET', body, token = secret, extraHeaders = {}) {
  return mf.dispatchFetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function rpc(method, params, token = secret) {
  const response = await request('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method, params }, token, {
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-03-26',
  });
  assert.equal(response.status, 200, await response.clone().text());
  if (response.headers.get('Content-Type')?.includes('text/event-stream')) {
    const text = await response.text();
    const message = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim()))
      .find((value) => value.id === 1);
    assert.ok(message, text);
    return message;
  }
  return response.json();
}
test('private endpoints reject absent and invalid credentials; health is public', async () => {
  assert.equal((await request('/health', 'GET', undefined, '')).status, 200);
  for (const path of ['/api/v1/books', '/mcp']) {
    const r = await request(path, 'GET', undefined, '');
    assert.equal(r.status, 401);
    assert.match(r.headers.get('WWW-Authenticate'), /resource_metadata/);
    assert.equal((await request(path, 'GET', undefined, 'wrong')).status, 401);
  }
});
test('OAuth discovery advertises Atlas, PKCE, registration, CIMD and required scope', async () => {
  const metadata = await (
    await request('/.well-known/oauth-protected-resource', 'GET', undefined, '')
  ).json();
  assert.equal(metadata.resource, base);
  assert.deepEqual(metadata.authorization_servers, [base]);
  assert.deepEqual(metadata.scopes_supported, ['atlas']);
  const server = await (
    await request('/.well-known/oauth-authorization-server', 'GET', undefined, '')
  ).json();
  assert.equal(server.authorization_endpoint, base + '/authorize');
  assert.equal(server.token_endpoint, base + '/oauth/token');
  assert.equal(server.registration_endpoint, base + '/oauth/register');
  assert.ok(server.code_challenge_methods_supported.includes('S256'));
  assert.equal(server.client_id_metadata_document_supported, true);
});
test('browser origins and preflight are enforced', async () => {
  assert.equal(
    (await request('/api/v1/books', 'GET', undefined, secret, { Origin: 'https://evil.example' }))
      .status,
    403,
  );
  assert.equal((await request('/mcp', 'POST', {}, secret, { Origin: 'null' })).status, 403);
  const r = await request('/api/v1/books', 'OPTIONS', undefined, '', {
    Origin: 'https://dashboard.example',
    'Access-Control-Request-Method': 'POST',
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://dashboard.example');
});
test('MCP initializes and lists five tools with usable schemas', async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'integration', version: '1' },
  });
  assert.equal(init.result.serverInfo.name, 'atlas');
  const list = await rpc('tools/list', {});
  assert.equal(list.result.tools.length, 5);
  assert.ok(list.result.tools.find((t) => t.name === 'add_book').inputSchema.properties.title);
});
test('MCP writes are visible through HTTP; duplicate ISBN rejected; update and delete shared', async () => {
  const added = await rpc('tools/call', {
    name: 'add_book',
    arguments: {
      title: 'A Wizard of Earthsea',
      authors: ['Ursula K. Le Guin'],
      tags: ['fantasy'],
      isbn: '978-0-547-77374-2',
      coverUrl: 'https://example.com/cover.jpg',
      sourceUrls: ['https://example.com/book'],
    },
  });
  assert.ok(!added.result.isError, JSON.stringify(added));
  const book = JSON.parse(added.result.content[0].text);
  const get = await (await request('/api/v1/books/' + book.id)).json();
  assert.equal(get.title, 'A Wizard of Earthsea');
  assert.equal(get.isbn, '9780547773742');
  assert.equal(
    (await request('/api/v1/books', 'POST', { title: 'Duplicate', isbn: book.isbn })).status,
    409,
  );
  const patch = await request('/api/v1/books/' + book.id, 'PATCH', {
    status: 'reading',
    coverUrl: null,
  });
  assert.equal(patch.status, 200);
  const updated = await rpc('tools/call', { name: 'get_book', arguments: { id: book.id } });
  const saved = JSON.parse(updated.result.content[0].text);
  assert.equal(saved.status, 'reading');
  assert.equal(saved.coverUrl, null);
  assert.deepEqual(saved.authors, ['Ursula K. Le Guin']);
  const filtered = await (
    await request('/api/v1/books?q=Le%20Guin&tag=fantasy&status=reading')
  ).json();
  assert.equal(filtered.items.length, 1);
  assert.equal((await request('/api/v1/books/' + book.id, 'DELETE')).status, 204);
  assert.equal((await request('/api/v1/books/' + book.id)).status, 404);
});
test('invalid metadata and unknown fields are rejected without writes', async () => {
  for (const body of [
    { title: '' },
    { title: 'x', isbn: '9780547773741' },
    { title: 'x', coverUrl: 'javascript:alert(1)' },
    { title: 'x', arbitrary: true },
  ]) {
    assert.equal((await request('/api/v1/books', 'POST', body)).status, 400);
  }
  assert.equal((await request('/api/v1/books/missing', 'PATCH', {})).status, 400);
  assert.equal((await request('/api/v1/books?limit=0')).status, 400);
  const invalid = await rpc('tools/call', { name: 'add_book', arguments: { title: '' } });
  assert.ok(invalid.error || invalid.result.isError);
});
test('pagination and literal search operate on real D1', async () => {
  const ids = [];
  for (const title of ['100% Read', 'Other Book', 'Third Book']) {
    const r = await request('/api/v1/books', 'POST', { title });
    assert.equal(r.status, 201);
    ids.push((await r.json()).id);
  }
  const page = await (await request('/api/v1/books?limit=2')).json();
  assert.equal(page.items.length, 2);
  assert.equal(page.nextOffset, 2);
  const next = await (await request('/api/v1/books?limit=2&offset=2')).json();
  assert.equal(next.items.length, 1);
  assert.equal(next.nextOffset, null);
  const search = await (await request('/api/v1/books?q=%25')).json();
  assert.equal(search.items.length, 1);
  for (const id of ids) await request('/api/v1/books/' + id, 'DELETE');
});

// Simulate a browser while keeping each flow's host-only state/consent cookies separate.
function browser() {
  const cookies = new Map();
  return async (path, form) => {
    const response = await mf.dispatchFetch(new URL(path, base), {
      method: form ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(form ? { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0];
      const index = pair.indexOf('=');
      const key = pair.slice(0, index),
        value = pair.slice(index + 1);
      if (!value || /max-age=0/i.test(cookie)) cookies.delete(key);
      else cookies.set(key, value);
    }
    return response;
  };
}
const sha256 = (value) => createHash('sha256').update(value).digest('base64url');
async function register(name = 'Test MCP client', redirect = clientRedirect) {
  const response = await request(
    '/oauth/register',
    'POST',
    {
      client_name: name,
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    '',
  );
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
async function startFlow({
  name,
  scope = 'atlas offline_access',
  client: knownClient,
  redirect = clientRedirect,
} = {}) {
  const client = knownClient || (await register(name, redirect));
  const verifier = randomUUID() + randomUUID();
  const state = randomUUID();
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    resource: base,
    scope,
    state,
    code_challenge: sha256(verifier),
    code_challenge_method: 'S256',
  });
  const visit = browser();
  const page = await visit('/authorize?' + params);
  assert.equal(page.status, 200, await page.clone().text());
  const html = await page.text();
  const styleNonce = /<style nonce="([^"]+)"/.exec(html)?.[1];
  assert.ok(styleNonce, 'Consent styles need a per-response nonce');
  assert.ok(
    page.headers.get('Content-Security-Policy').includes(`style-src 'nonce-${styleNonce}'`),
  );
  assert.ok(!page.headers.get('Content-Security-Policy').includes("'unsafe-inline'"));

  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(handle, html);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  // Real Chromium browsers also check the form's redirect targets against form-action.
  const policy = page.headers.get('Content-Security-Policy');
  const sources = policy
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .find(([name]) => name === 'form-action')
    .slice(1);
  assert.ok(sources.includes("'self'"));
  assert.ok(sources.includes('https://github.com'), 'Approval must be able to reach GitHub');
  assert.ok(
    sources.includes(new URL(redirect).origin),
    'Denial must be able to return to the registered client',
  );
  assert.ok(
    !sources.includes('*') && !sources.includes('https:'),
    'Allow only specific OAuth destinations',
  );
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  const cookie = page.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Lax/i);
  return { client, verifier, state, params, visit, html, handle };
}
async function approve(flow) {
  const response = await flow.visit('/authorize', { handle: flow.handle, decision: 'approve' });
  assert.equal(response.status, 302, await response.clone().text());
  const github = new URL(response.headers.get('Location'));
  assert.equal(github.origin, 'https://github.com');
  assert.equal(github.pathname, '/login/oauth/authorize');
  assert.equal(github.searchParams.get('client_id'), 'test-github-client');
  assert.equal(github.searchParams.get('redirect_uri'), base + '/auth/github/callback');
  assert.equal(github.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(github.searchParams.get('scope'), ''); // Only public profile identity is needed.
  assert.ok(!github.searchParams.has('client_secret'));
  return github;
}
async function mockOutbound(request) {
  try {
    const url = new URL(request.url);
    if (url.href === 'https://github.com/login/oauth/access_token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      const pending = githubExchanges.get(form.get('code'));
      assert.ok(pending, 'Unexpected GitHub code exchange');
      githubExchanges.delete(form.get('code'));
      assert.equal(form.get('client_id'), 'test-github-client');
      assert.equal(form.get('client_secret'), 'test-github-secret');
      assert.equal(form.get('redirect_uri'), base + '/auth/github/callback');
      assert.equal(
        sha256(form.get('code_verifier') || ''),
        pending.github.searchParams.get('code_challenge'),
      );
      return Response.json(
        pending.tokenStatus === 200
          ? { access_token: pending.token, token_type: 'bearer' }
          : { error: 'server_error' },
        { status: pending.tokenStatus },
      );
    }
    if (url.href === 'https://api.github.com/user' && request.method === 'GET') {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '');
      const user = githubUsers.get(token);
      assert.ok(user, 'Unexpected GitHub identity request');
      githubUsers.delete(token);
      return Response.json(user);
    }
    const document = clientDocuments.get(url.href);
    if (document && request.method === 'GET') return Response.json(document);
    assert.fail('Unexpected outbound request: ' + url.href);
  } catch (error) {
    outboundFailures.push(error.message);
    return Response.json({ error: 'Unexpected mock request' }, { status: 500 });
  }
}
function mockGithub(github, { id = Number(ownerId), tokenStatus = 200 } = {}) {
  const code = randomUUID(),
    token = 'github-test-' + randomUUID();
  githubExchanges.set(code, { github, tokenStatus, token });
  if (tokenStatus === 200)
    githubUsers.set(token, { id, login: id === Number(ownerId) ? 'atlas-owner' : 'someone-else' });
  return code;
}
async function callback(flow, github, options) {
  const code = mockGithub(github, options);
  return flow.visit(
    '/auth/github/callback?' +
      new URLSearchParams({ code, state: github.searchParams.get('state') }),
  );
}
async function tokenRequest(form) {
  return mf.dispatchFetch(base + '/oauth/token', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
}
async function exchange(flow, code, overrides = {}) {
  return tokenRequest({
    client_id: flow.client.client_id,
    grant_type: 'authorization_code',
    code,
    code_verifier: flow.verifier,
    redirect_uri: clientRedirect,
    resource: base,
    ...overrides,
  });
}
async function signIn(options) {
  const flow = await startFlow(options);
  const github = await approve(flow);
  const response = await callback(flow, github);
  assert.equal(response.status, 302, await response.clone().text());
  const redirect = new URL(response.headers.get('Location'));
  assert.equal(redirect.origin + redirect.pathname, clientRedirect);
  assert.equal(redirect.searchParams.get('state'), flow.state);
  assert.equal(redirect.searchParams.get('iss'), base);
  const code = redirect.searchParams.get('code');
  assert.ok(code, redirect.href);
  const issued = await exchange(flow, code);
  assert.equal(issued.status, 200, await issued.clone().text());
  const tokens = await issued.json();
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  assert.equal(tokens.expires_in, 3600);
  return { flow, tokens, code, github };
}

test('GitHub owner sign-in issues Atlas tokens usable through HTTP and MCP', async () => {
  const { flow, tokens, code } = await signIn();
  const oauthToken = tokens.access_token;
  assert.ok(!tokens.access_token.startsWith('github-test-'));
  assert.equal((await request('/api/v1/books', 'GET', undefined, oauthToken)).status, 200);
  const rpcResponse = await request(
    '/mcp',
    'POST',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    },
    oauthToken,
    { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' },
  );
  assert.equal(rpcResponse.status, 200, await rpcResponse.clone().text());
  assert.match(await rpcResponse.text(), /add_book/);
  assert.equal((await exchange(flow, code)).status, 400); // Authorization codes are single-use.
  const kv = await mf.getKVNamespace('OAUTH_KV');
  const keys = await kv.list();
  for (const key of keys.keys) {
    const stored = await kv.get(key.name);
    assert.ok(!stored.includes('github-test-'), 'GitHub credentials must not be retained');
    assert.ok(!stored.includes('test-github-secret'));
  }
});
test('a different GitHub account is denied and receives no Atlas code', async () => {
  const flow = await startFlow();
  const github = await approve(flow);
  const response = await callback(flow, github, { id: 98765 });
  const redirect = new URL(response.headers.get('Location'));
  assert.equal(redirect.searchParams.get('error'), 'access_denied');
  assert.equal(redirect.searchParams.get('state'), flow.state);
  assert.ok(!redirect.searchParams.has('code'));
});
test('consent is browser-bound, escaped, and single-use; denial preserves client state', async () => {
  const flow = await startFlow({ name: '<script>alert("x")</script>' });
  assert.ok(!flow.html.includes('<script>'));
  assert.match(flow.html, /&#60;script&#62;/);
  const forged = await browser()('/authorize', { handle: flow.handle, decision: 'approve' });
  assert.equal(forged.status, 400);
  const denied = await flow.visit('/authorize', { handle: flow.handle, decision: 'deny' });
  assert.equal(denied.status, 302);
  const redirect = new URL(denied.headers.get('Location'));
  assert.equal(redirect.searchParams.get('error'), 'access_denied');
  assert.equal(redirect.searchParams.get('state'), flow.state);
  assert.equal(
    (await flow.visit('/authorize', { handle: flow.handle, decision: 'approve' })).status,
    400,
  );
});
test('GitHub callback refuses missing, forged, cross-browser and reused state', async () => {
  assert.equal((await browser()('/auth/github/callback?code=x')).status, 400);
  const flow = await startFlow();
  const github = await approve(flow);
  const path =
    '/auth/github/callback?' +
    new URLSearchParams({ code: 'never-exchanged', state: github.searchParams.get('state') });
  assert.equal((await browser()(path)).status, 400);
  assert.equal((await flow.visit('/auth/github/callback?code=x&state=forged')).status, 400);
  // A denied upstream login consumes the valid state without calling GitHub's API.
  const cancelledPath =
    '/auth/github/callback?' +
    new URLSearchParams({ error: 'access_denied', state: github.searchParams.get('state') });
  const cancelled = await flow.visit(cancelledPath);
  const redirect = new URL(cancelled.headers.get('Location'));
  assert.equal(redirect.searchParams.get('error'), 'access_denied');
  assert.equal(redirect.searchParams.get('state'), flow.state);
  assert.equal((await flow.visit(cancelledPath)).status, 400);
});
test('unregistered redirects, unsupported scopes and plain PKCE are refused', async () => {
  const flow = await startFlow();
  const invalidRedirect = new URLSearchParams(flow.params);
  invalidRedirect.set('redirect_uri', 'https://attacker.example/callback');
  const rejected = await request('/authorize?' + invalidRedirect, 'GET', undefined, '');
  assert.equal(rejected.status, 400);
  assert.ok(!rejected.headers.has('Location'));
  for (const [name, value] of [
    ['scope', 'admin'],
    ['code_challenge_method', 'plain'],
    ['resource', 'https://other.example'],
  ]) {
    const params = new URLSearchParams(flow.params);
    params.set(name, value);
    const response = await request('/authorize?' + params, 'GET', undefined, '');
    assert.ok([302, 400].includes(response.status));
    assert.ok(!(await response.text()).includes('<form'));
  }
});
test('wrong client, resource and PKCE verifier cannot exchange an Atlas authorization code', async () => {
  for (const overrides of [
    { code_verifier: 'incorrect-verifier' },
    { resource: 'https://other.example' },
    { client_id: (await register()).client_id },
  ]) {
    const flow = await startFlow();
    const github = await approve(flow);
    const response = await callback(flow, github);
    const code = new URL(response.headers.get('Location')).searchParams.get('code');
    assert.ok(code, response.headers.get('Location'));
    const rejected = await exchange(flow, code, overrides);
    assert.equal(rejected.status, 400, await rejected.clone().text());
    assert.ok(!(await rejected.json()).access_token);
  }
});
test('GitHub outages return a safe error to the validated client', async () => {
  const flow = await startFlow();
  const github = await approve(flow);
  const response = await callback(flow, github, { tokenStatus: 503 });
  const redirect = new URL(response.headers.get('Location'));
  assert.equal(redirect.searchParams.get('error'), 'temporarily_unavailable');
  assert.equal(redirect.searchParams.get('state'), flow.state);
  assert.ok(!redirect.href.includes('test-github-secret'));
});
test('refresh rotates tokens; revoking the grant prevents further access and refresh', async () => {
  const { flow, tokens } = await signIn();
  const refreshed = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: flow.client.client_id,
    resource: base,
  });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const next = await refreshed.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.equal((await request('/api/v1/books', 'GET', undefined, next.access_token)).status, 200);
  // The library allows the previous refresh token until its replacement is used.
  const secondRefresh = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: next.refresh_token,
    client_id: flow.client.client_id,
    resource: base,
  });
  assert.equal(secondRefresh.status, 200);
  const latest = await secondRefresh.json();
  assert.equal(
    (
      await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: flow.client.client_id,
        resource: base,
      })
    ).status,
    400,
  );
  const revoked = await tokenRequest({
    token: latest.refresh_token,
    token_type_hint: 'refresh_token',
    client_id: flow.client.client_id,
  });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.equal((await request('/api/v1/books', 'GET', undefined, latest.access_token)).status, 401);
  assert.equal(
    (
      await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: latest.refresh_token,
        client_id: flow.client.client_id,
        resource: base,
      })
    ).status,
    400,
  );
});
test('CIMD clients can discover consent with their verified domain', async () => {
  const clientId = 'https://chatgpt.com/oauth/client.json';
  clientDocuments.set(clientId, {
    client_id: clientId,
    client_name: 'ChatGPT',
    redirect_uris: [clientRedirect],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  const flow = await startFlow({ client: { client_id: clientId } });
  assert.match(flow.html, /Client domain: <strong>chatgpt.com<\/strong>/);
  assert.match(flow.html, /client.example/);
});
test('tokens without atlas scope cannot reach either transport', async () => {
  const { flow, tokens } = await signIn();
  const refreshed = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: flow.client.client_id,
    resource: base,
    scope: 'offline_access',
  });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const narrowed = await refreshed.json();
  for (const path of ['/mcp', '/api/v1/books']) {
    const denied = await request(path, 'GET', undefined, narrowed.access_token);
    assert.equal(denied.status, 403);
    assert.match(denied.headers.get('WWW-Authenticate'), /insufficient_scope/);
  }
});
test('absent GitHub configuration keeps personal-token access and fails closed otherwise', async () => {
  const local = new Miniflare({
    upstream: 'http://127.0.0.1',
    modules: true,
    scriptPath: 'dist/index.js',
    compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    bindings: {},
    d1Databases: ['DB'],
  });
  try {
    assert.equal((await local.dispatchFetch('http://localhost/api/v1/books')).status, 503);
    assert.equal((await local.dispatchFetch('http://localhost/mcp')).status, 503);
    assert.equal((await local.dispatchFetch('http://localhost/authorize')).status, 503);
    assert.equal(
      (await local.dispatchFetch('http://localhost/.well-known/oauth-authorization-server')).status,
      404,
    );
    await local.setOptions({
      upstream: 'http://127.0.0.1',
      modules: true,
      scriptPath: 'dist/index.js',
      compatibilityDate: '2026-08-01',
      compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
      bindings: { API_TOKEN: secret },
      d1Databases: ['DB'],
    });
    const direct = await local.dispatchFetch('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-03-26',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(direct.status, 200);
    assert.match(await direct.text(), /add_book/);
  } finally {
    await local.dispose();
  }
});
