import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
// `./token.js`, with the extension: this module is deliberately loadable by
// plain node so its tests can run outside Next, and node's ESM resolver does
// not guess extensions. Next accepts the explicit form too.
import { readToken, signedPayload, tokenFresh } from './token.js';

/*
 * Issuing and verifying the session cookie, with node's crypto and NOTHING from
 * Next. That separation is the point of this file: `lib/auth.js` needs
 * `next/headers` to reach the cookie jar, which makes it unimportable outside a
 * Next runtime and therefore untestable — and this is the code that decides who
 * gets in, so it is the code that most needs a test.
 *
 * The cookie is `<issuedAt>.<nonce>.<signature>`, signed with HMAC-SHA256 under
 * DASHBOARD_PASSWORD. Its shape and lifetime live in ./token, which has no node
 * imports either, so `middleware.js` can hold the same rules on the edge.
 *
 * It used to be `sha256("bookings-webui:" + password)` — a pure function of the
 * password and nothing else. Two consequences:
 *
 *   * it never expired. `maxAge: 12h` told the BROWSER when to forget it, and
 *     the server would have accepted the same string a year later. A value that
 *     leaked once — a shared laptop, a screen share, a proxy log — stayed valid
 *     until the password itself was changed, and changing it signs everyone out.
 *   * every session was the same string, so one leak was every session.
 *
 * The issue time is now inside the cookie and covered by the signature, so the
 * server decides when a session ends, and the nonce makes each sign-in distinct.
 * Still stateless: no session table, and DASHBOARD_PASSWORD remains the only
 * secret. Rotating it still invalidates everything, which is the emergency stop.
 */

function sign(password, issuedAt, nonce) {
  return createHmac('sha256', password)
    .update(signedPayload(issuedAt, nonce)).digest('hex');
}

export function issueToken(password, now = Date.now()) {
  const issuedAt = String(now);
  const nonce = randomBytes(12).toString('hex');
  return `${issuedAt}.${nonce}.${sign(password, issuedAt, nonce)}`;
}

/** Constant-time compare, once both sides are known to be the same length. */
function sameSignature(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function verifyToken(password, value, now = Date.now()) {
  const parsed = readToken(value);
  if (!parsed) return false;
  if (!tokenFresh(parsed.issuedAt, now)) return false;
  return sameSignature(parsed.signature, sign(password, parsed.issuedAt, parsed.nonce));
}
