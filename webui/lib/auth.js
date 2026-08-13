import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';

export const COOKIE = 'dash';

// The cookie is a bearer token derived from the password. The middleware
// recomputes the same value with Web Crypto, so the input string must match
// there byte for byte.
export function sessionToken(password) {
  return createHash('sha256').update(`bookings-webui:${password}`).digest('hex');
}

export function authConfigured() {
  return Boolean(process.env.DASHBOARD_PASSWORD);
}

export async function signedIn() {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return false;
  const jar = await cookies();
  return jar.get(COOKIE)?.value === sessionToken(password);
}
