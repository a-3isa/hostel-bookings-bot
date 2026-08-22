import { cookies } from 'next/headers';
import { SESSION_MS } from './token';
import { issueToken, verifyToken } from './session';

export const COOKIE = 'dash';
export { SESSION_MS, issueToken };

// The cookie jar, and nothing else. Everything that DECIDES anything about a
// session lives in ./session (issuing and verifying, with node's crypto) and
// ./token (shape and lifetime, with no crypto at all, so `middleware.js` can
// share it on the edge runtime). This file is the only one that needs
// `next/headers`, which is what makes the other two testable outside Next.

export function authConfigured() {
  return Boolean(process.env.DASHBOARD_PASSWORD);
}

export async function signedIn() {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return false;
  const jar = await cookies();
  return verifyToken(password, jar.get(COOKIE)?.value);
}
