import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './env';
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export function oauthEnabled(env: Env) {
  return !!(env.OAUTH_ISSUER && env.OAUTH_JWKS_URL && env.OAUTH_AUDIENCE && env.OAUTH_OWNER_SUB);
}
export async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (env.API_TOKEN) {
    const digest = async (v: string) =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
    const [a, b] = await Promise.all([digest(token), digest(env.API_TOKEN)]);
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    if (!difference) return true;
  }
  if (!oauthEnabled(env)) return false;
  try {
    const jwksUrl = env.OAUTH_JWKS_URL!;
    let jwks = keys.get(jwksUrl);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(jwksUrl));
      keys.set(jwksUrl, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.OAUTH_ISSUER,
      audience: env.OAUTH_AUDIENCE,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['exp', 'sub'],
    });
    return (
      payload.sub === env.OAUTH_OWNER_SUB &&
      typeof payload.scope === 'string' &&
      payload.scope.split(' ').includes('atlas')
    );
  } catch {
    return false;
  }
}
