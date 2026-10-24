import { Hono } from 'hono';
import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
} from '@cloudflare/workers-oauth-provider';
import { z } from 'zod';
import { publicOrigin } from './auth';
import type { AuthProps, Env } from './env';
import { handleError } from './errors';
import { consentPage } from './consent';

async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

type FailureCode = 'access_denied' | 'temporarily_unavailable';
class GitHubSignInError extends Error {
  constructor(
    public code: FailureCode,
    message: string,
  ) {
    super(message);
  }
}

async function githubIdentity(code: string, verifier: string, env: Env): Promise<AuthProps> {
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID!,
        client_secret: env.GITHUB_CLIENT_SECRET!,
        code,
        redirect_uri: `${publicOrigin(env)}/auth/github/callback`,
        code_verifier: verifier,
      }),
    });
  } catch {
    throw new GitHubSignInError(
      'temporarily_unavailable',
      'GitHub sign-in is unavailable. Start the connection again.',
    );
  }
  if (!tokenResponse.ok)
    throw new GitHubSignInError('temporarily_unavailable', 'GitHub could not complete sign-in.');
  const token = z
    .object({ access_token: z.string().min(1), token_type: z.string().regex(/^bearer$/i) })
    .safeParse(await tokenResponse.json());
  if (!token.success)
    throw new GitHubSignInError('access_denied', 'GitHub did not authorize this sign-in.');

  let userResponse: Response;
  try {
    userResponse = await fetch('https://api.github.com/user', {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${token.data.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Atlas',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch {
    throw new GitHubSignInError(
      'temporarily_unavailable',
      'GitHub identity verification is unavailable.',
    );
  }
  if (!userResponse.ok)
    throw new GitHubSignInError('temporarily_unavailable', 'GitHub identity verification failed.');
  const user = z
    .object({ id: z.number().int().positive().safe(), login: z.string().min(1).max(100) })
    .safeParse(await userResponse.json());
  if (!user.success)
    throw new GitHubSignInError('access_denied', 'GitHub returned an invalid identity.');
  if (String(user.data.id) !== env.GITHUB_OWNER_ID)
    throw new GitHubSignInError(
      'access_denied',
      'This GitHub account does not own this reading list.',
    );
  // GitHub credentials are used only to establish identity, never persisted or sent to the client.
  return { githubId: String(user.data.id), githubLogin: user.data.login };
}

export const githubAuth = new Hono<{ Bindings: Env }>();

githubAuth.get('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER!;
  const request = await oauth.parseAuthRequest(c.req.raw);
  if (!request.scope.includes('atlas'))
    return c.redirect(
      authorizationErrorRedirect(request, 'invalid_scope', 'Request the atlas scope.'),
      302,
    );
  const details = await oauth.describeConsent(request);
  const consent = await oauth.beginConsent(request);
  consent.headers.set('Content-Type', 'text/html; charset=utf-8');
  // Chromium checks form-action against the redirect chain too. Both approval
  // (GitHub) and denial (the registered client callback) leave our own origin.
  // describeConsent only returns a callback validated against the client's registration.
  const callbackOrigin = new URL(details.redirectUri).origin;
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  consent.headers.set(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self' https://github.com ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`,
  );
  return new Response(consentPage(details, consent.handle, nonce), { headers: consent.headers });
});

githubAuth.post('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER!;
  const form = await c.req.formData();
  const handle = String(form.get('handle') || '');
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(c.req.raw, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(c.req.raw, handle);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const upstream = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID!,
    redirect_uri: `${publicOrigin(c.env)}/auth/github/callback`,
    state: upstream.state,
    scope: '',
    code_challenge: await challenge(verifier),
    code_challenge_method: 'S256',
    allow_signup: 'false',
  }).toString();
  upstream.headers.set('Location', url.href);
  return new Response(null, { status: 302, headers: upstream.headers });
});

githubAuth.get('/auth/github/callback', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER!;
  const upstream = await oauth.finishUpstream<{ verifier: string }>(c.req.raw);
  const redirectError = (code: FailureCode, description: string) => {
    upstream.headers.set(
      'Location',
      authorizationErrorRedirect(upstream.request, code, description),
    );
    return new Response(null, { status: 302, headers: upstream.headers });
  };
  const code = c.req.query('code');
  if (c.req.query('error') || !code)
    return redirectError('access_denied', 'GitHub sign-in was cancelled.');
  let identity: AuthProps;
  try {
    identity = await githubIdentity(code, upstream.data.verifier, c.env);
  } catch (error) {
    if (error instanceof GitHubSignInError) return redirectError(error.code, error.message);
    return redirectError(
      'temporarily_unavailable',
      'GitHub sign-in failed. Start the connection again.',
    );
  }
  const { redirectTo } = await oauth.completeAuthorization({
    request: upstream.request,
    userId: identity.githubId,
    metadata: { githubLogin: identity.githubLogin },
    scope: upstream.request.scope,
    props: identity,
  });
  upstream.headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers: upstream.headers });
});

githubAuth.notFound((c) => c.json({ error: 'Not found' }, 404));

githubAuth.onError((error, c) => {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo) return c.redirect(error.redirectTo, 302);
    return c.text(error.description, 400);
  }
  if (error instanceof CimdFetchError)
    return c.text('The OAuth client could not be verified.', 400);
  return handleError(error, c);
});
