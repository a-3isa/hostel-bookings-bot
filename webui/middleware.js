import { NextResponse } from 'next/server';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|login).*)'],
};

async function sessionToken(password) {
  const bytes = new TextEncoder().encode(`bookings-webui:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function middleware(request) {
  const password = process.env.DASHBOARD_PASSWORD;

  // No password configured means no way to authenticate, so nothing is
  // reachable. Failing closed matters here: the pages behind this hold guest
  // names, phone numbers and payments.
  if (!password) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  const presented = request.cookies.get('dash')?.value;
  if (presented && presented === (await sessionToken(password))) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}
