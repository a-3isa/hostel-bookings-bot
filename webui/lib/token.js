/*
 * The session cookie's shape and lifetime, with NO crypto and NO node imports.
 *
 * This exists as its own module because two runtimes need the same rules and
 * only one of them may import `node:crypto`: `lib/auth.js` runs on the server
 * and signs with node, while `middleware.js` runs on the edge and can only use
 * Web Crypto. Anything either of them can share lives here, so the parts that
 * decide whether a cookie is acceptable are written once.
 *
 * The cookie is `<issuedAt>.<nonce>.<signature>`, and the issue time is inside
 * it and signed, so the SERVER decides when a session ends. The browser's own
 * `maxAge` is a hint it may ignore, and an attacker holding a stolen value
 * ignores it entirely.
 */

export const SESSION_MS = 12 * 60 * 60 * 1000;

/** The three parts, or null if this is not a cookie we could have issued. */
export function readToken(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3) return null;
  const [issuedAt, nonce, signature] = parts;
  if (!/^\d+$/.test(issuedAt)) return null;
  if (!/^[0-9a-f]{24}$/.test(nonce)) return null;
  if (!/^[0-9a-f]{64}$/.test(signature)) return null;
  return { issuedAt, nonce, signature };
}

export function tokenFresh(issuedAt, now = Date.now()) {
  const age = now - Number(issuedAt);
  // A cookie issued in the future is a clock problem or a forgery attempt; in
  // neither case is it something to accept.
  return age >= 0 && age < SESSION_MS;
}

/** What the signature is computed over. Both runtimes must agree byte for byte. */
export function signedPayload(issuedAt, nonce) {
  return `${issuedAt}.${nonce}`;
}

/**
 * Length-independent hex compare.
 *
 * `crypto.subtle` has no timingSafeEqual, so the edge side needs this; the
 * server side uses node's real one. Neither is defending against a practical
 * remote timing attack on a 64-character hex string — it is simply cheap to do
 * properly on the gate in front of guest names, phone numbers and payments.
 */
export function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
