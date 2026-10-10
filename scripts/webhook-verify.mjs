/**
 * verifyGhostSignature — check a Ghost Bridge webhook signature (v4.2).
 *
 * When the relay has GHOST_BRIDGE_WEBHOOK_SECRET set, every outbound
 * webhook POST carries:
 *   x-ghost-event:     <event type, e.g. task.created>
 *   x-ghost-signature: sha256=<hmac-sha256 hex of the RAW request body>
 *
 * Verify with the same secret on the receiving side. Pass the raw body
 * exactly as received (a string or Buffer) — NOT a re-stringified parse,
 * or the HMAC won't match.
 *
 *   import { verifyGhostSignature } from './webhook-verify.mjs';
 *   const ok = verifyGhostSignature(rawBody, req.headers['x-ghost-signature'], process.env.GHOST_BRIDGE_WEBHOOK_SECRET);
 *   if (!ok) { res.writeHead(401); return res.end('bad signature'); }
 */
import crypto from 'node:crypto';

export function verifyGhostSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = 'sha256=' + crypto.createHmac('sha256', String(secret)).update(bodyBuf).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default verifyGhostSignature;
