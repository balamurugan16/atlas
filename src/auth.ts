import type { Env } from './env';

export function publicOrigin(env: Env): string | null {
  if (!env.PUBLIC_URL) return null;
  try {
    const url = new URL(env.PUBLIC_URL);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function oauthEnabled(env: Env): boolean {
  return !!(
    publicOrigin(env) &&
    env.OAUTH_KV &&
    env.GITHUB_CLIENT_ID &&
    env.GITHUB_CLIENT_SECRET &&
    env.GITHUB_OWNER_ID &&
    /^[1-9]\d*$/.test(env.GITHUB_OWNER_ID)
  );
}

export async function authorizedWithApiToken(request: Request, env: Env): Promise<boolean> {
  if (!env.API_TOKEN) return false;
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return false;
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(header.slice(7)), digest(env.API_TOKEN)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
