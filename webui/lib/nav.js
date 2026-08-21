// Where a redirect is allowed to send someone.
//
// Its own module rather than a helper inside `app/actions.js`, for two reasons:
// a `'use server'` file may only export async functions, and this is the kind
// of rule that is worth a test — `lib/mirror.test.mjs` pins it.

// The origin a candidate path is resolved against. Never reached: it exists so
// that anything which escapes this site resolves to a DIFFERENT origin and can
// be seen doing it.
const HERE = 'https://dashboard.invalid';

// `next.startsWith('/')` is not enough on its own, which is what the login
// action used to check. `//evil.com` starts with a slash and a browser resolves
// it as `https://evil.com` — protocol-relative — so a link of the form
// `…/login?next=//evil.com` sent to a member of staff authenticates them here
// and then drops them on a lookalike that can ask for the password again. A
// backslash does the same in browsers that fold it to a slash, and a tab or a
// newline in front of the second slash hides it from a naive character check
// because the browser strips those before resolving.
//
// Rejecting the first two outright and then RESOLVING the rest is what covers
// the third: WHATWG URL strips the same whitespace a browser does, so
// `/<tab>/evil.com` comes back with evil.com as its origin and is refused. What
// survives is returned normalised, so only a path on this site is ever handed
// to `redirect()`.
export function safeNext(raw) {
  const next = String(raw ?? '');
  if (!next.startsWith('/')) return '/';
  if (next.startsWith('//')) return '/';
  if (next.includes('\\')) return '/';
  try {
    const url = new URL(next, HERE);
    if (url.origin !== HERE) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
