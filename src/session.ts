/**
 * Session Auth Client for clara-proxy
 *
 * Implements SIWE (Sign-In with Ethereum) delegation + ephemeral session keys.
 * The wallet signs a SIWE message (via sign-raw) that delegates authority to
 * a locally-generated session key. Subsequent requests are signed with the
 * session key, avoiding repeated wallet interactions.
 *
 * Reference: clara-proxy/src/auth-middleware.js
 */

import * as secp from '@noble/secp256k1';
import { hashMessage, type Hex } from 'viem';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SIGNAL402_DIR = join(homedir(), '.signal402');
const SESSION_FILE = join(SIGNAL402_DIR, 'session.json');
const CLARA_PROXY = 'https://clara-proxy.bflynn-me.workers.dev';

interface SessionData {
  sessionId: string;
  address: string;
  sessionPrivateKey: string; // hex-encoded ephemeral private key
  sessionPublicKey: string;  // hex-encoded uncompressed public key
  expiresAt: number;         // unix ms
  createdAt: string;
}

// ── Helpers ─────────────────────────────────────

/** SHA-256 hex digest via Web Crypto (works in Node 18+) */
async function sha256hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Convert Uint8Array to hex string */
function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Convert hex string to Uint8Array */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── Keypair Generation ─────────────────────────

function generateSessionKeypair(): { privateKey: Uint8Array; publicKey: string } {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = secp.getPublicKey(privateKey, false); // uncompressed (04 prefix)
  return { privateKey, publicKey: bytesToHex(publicKey) };
}

// ── SIWE Message Construction ──────────────────

function constructSiweMessage(
  address: string,
  nonce: string,
  sessionPubKey: string,
  expirationTime: string,
): string {
  const domain = 'clara-proxy.bflynn-me.workers.dev';
  const uri = `https://${domain}`;
  const issuedAt = new Date().toISOString();
  const chainId = 8453;

  // Statement embeds the session public key — proxy verifies this is present
  const statement = `Delegate signing authority to session key: ${sessionPubKey}`;

  // ERC-4361 format — must match parseSiweMessage on the proxy side exactly
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    statement,
    '',
    `URI: ${uri}`,
    `Version: 1`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  ].join('\n');
}

// ── Session Bootstrap ──────────────────────────

/**
 * Full session bootstrap flow:
 * 1. GET /auth/nonce — get server-issued nonce
 * 2. Generate ephemeral keypair locally
 * 3. Construct SIWE message with session public key
 * 4. Sign SIWE via POST /api/v1/wallets/{walletId}/sign-raw (no session auth needed)
 * 5. POST /auth/session with { siweMessage, signature, sessionPublicKey }
 * 6. Get back { sessionId, address, expiresAt }
 */
export async function establishSession(
  walletId: string,
  address: string,
): Promise<SessionData> {
  // Step 1: Get server nonce
  const nonceRes = await fetch(`${CLARA_PROXY}/auth/nonce`);
  if (!nonceRes.ok) throw new Error(`Failed to get nonce: ${nonceRes.status}`);
  const { nonce } = (await nonceRes.json()) as { nonce: string };

  // Step 2: Generate ephemeral keypair
  const { privateKey, publicKey: sessionPubKey } = generateSessionKeypair();

  // Step 3: Construct SIWE message
  const expirationTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const siweMessage = constructSiweMessage(address, nonce, sessionPubKey, expirationTime);

  // Step 4: Sign SIWE via sign-raw (bootstrap path — no session auth needed)
  // Para's sign-raw signs a raw 32-byte hash. For personal_sign (EIP-191),
  // we must pre-hash with the Ethereum prefix ourselves, then send the hash.
  // This matches account.ts: hashMessage(message) → signRawHash(hash)
  const siweHash = hashMessage(siweMessage);

  const signRes = await fetch(`${CLARA_PROXY}/api/v1/wallets/${walletId}/sign-raw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Clara-Address': address,
    },
    body: JSON.stringify({ data: siweHash }),
  });

  if (!signRes.ok) {
    const errText = await signRes.text();
    throw new Error(`sign-raw failed: ${signRes.status} — ${errText}`);
  }

  const signData = (await signRes.json()) as { signature?: string; result?: string };
  const siweSignature = signData.signature || signData.result;
  if (!siweSignature) throw new Error('No signature in sign-raw response');

  // Step 5: Create session on proxy
  const sessionRes = await fetch(`${CLARA_PROXY}/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      siweMessage,
      signature: siweSignature,
      sessionPublicKey: sessionPubKey,
    }),
  });

  if (!sessionRes.ok) {
    const errBody = await sessionRes.text();
    throw new Error(`Session creation failed: ${sessionRes.status} — ${errBody}`);
  }

  const { sessionId, expiresAt } = (await sessionRes.json()) as {
    sessionId: string;
    address: string;
    expiresAt: number;
  };

  // Step 6: Save session locally
  const session: SessionData = {
    sessionId,
    address: address.toLowerCase(),
    sessionPrivateKey: bytesToHex(privateKey),
    sessionPublicKey: sessionPubKey,
    expiresAt,
    createdAt: new Date().toISOString(),
  };

  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });

  return session;
}

// ── Per-Request Signing ────────────────────────

/**
 * Sign an outgoing request with session credentials.
 *
 * Canonical message format (must match proxy's verifyRequest exactly):
 *   CLARA-REQUEST-SIG-V1
 *   {METHOD}
 *   {PATH}
 *   sha256:{bodyDigestHex}
 *   {timestamp}
 *   {nonce}
 *
 * Returns headers to attach to the request.
 */
export async function signRequest(
  session: SessionData,
  method: string,
  path: string,
  body: string,
): Promise<Record<string, string>> {
  const nonce = crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyDigest = await sha256hex(body);

  const canonicalMessage = [
    'CLARA-REQUEST-SIG-V1',
    method,
    path,
    `sha256:${bodyDigest}`,
    timestamp,
    nonce,
  ].join('\n');

  // SHA-256 the canonical message, then sign with ephemeral key
  const msgHash = await sha256hex(canonicalMessage);
  const msgHashBytes = hexToBytes(msgHash);
  const privKeyBytes = hexToBytes(session.sessionPrivateKey);

  const sig = await secp.signAsync(msgHashBytes, privKeyBytes, { lowS: true });
  // Encode as 65 bytes: r(32) + s(32) + recovery(1)
  const sigBytes = sig.toCompactRawBytes();
  const recovery = sig.recovery;
  const fullSig = new Uint8Array(65);
  fullSig.set(sigBytes);
  fullSig[64] = recovery! + 27; // Ethereum convention: 27/28

  return {
    'X-Clara-Address': session.address,
    'X-Clara-Session': session.sessionId,
    'X-Clara-Signature': '0x' + bytesToHex(fullSig),
    'X-Clara-Timestamp': timestamp,
    'X-Clara-Nonce': nonce,
  };
}

// ── Session Management ─────────────────────────

/**
 * Get a valid session, establishing one if needed.
 * Sessions are cached on disk and reused until they expire.
 */
export async function getSession(
  walletId: string,
  address: string,
): Promise<SessionData> {
  // Try to load existing session
  if (existsSync(SESSION_FILE)) {
    const session: SessionData = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));

    // Check if session is still valid (with 5-minute buffer)
    const bufferMs = 5 * 60 * 1000;
    if (session.expiresAt > Date.now() + bufferMs) {
      return session;
    }
    // Session expired or about to expire — re-establish
  }

  return establishSession(walletId, address);
}
