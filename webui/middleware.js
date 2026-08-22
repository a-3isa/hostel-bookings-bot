import { NextResponse } from 'next/server';
import { readToken, sameHex, signedPayload, tokenFresh } from './lib/token';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|login).*)'],
};

// The same HMAC lib/auth.js signs with, in Web Crypto because this file runs on
// the edge runtime and cannot import node:crypto. The SHAPE and FRESHNESS rules
// are imported rather than restated — they are pure and have no node
// dependency, and two copies of a verification rule are two places to get it
// wrong.
async function sign(password, issuedAt, nonce) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key,
                                       enc.encode(signedPayload(issuedAt, nonce)));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function middleware(request) {
  const password = process.env.DASHBOARD_PASSWORD;

  const toLogin = (withNext) => {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = withNext
      ? `?next=${encodeURIComponent(request.nextUrl.pathname)}`
      : '';
    return NextResponse.redirect(url);
  };

  // No password configured means no way to authenticate, so nothing is
  // reachable. Failing closed matters here: the pages behind this hold guest
  // names, phone numbers and payments.
  if (!password) return toLogin(false);

  const parsed = readToken(request.cookies.get('dash')?.value);
  if (parsed
      && tokenFresh(parsed.issuedAt)
      && sameHex(parsed.signature,
                       await sign(password, parsed.issuedAt, parsed.nonce))) {
    return NextResponse.next();
  }

  return toLogin(true);
}
