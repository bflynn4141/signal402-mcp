/**
 * x402 Payment Client for Signal402
 *
 * Uses the official @x402 SDK for protocol-compliant payment handling:
 * 1. Request a resource → get 402 with payment requirements
 * 2. SDK selects scheme, builds EIP-712 payload, calls our signer
 * 3. Para signer (account.ts) hashes + signs via clara-proxy
 * 4. SDK retries with standard payment headers
 *
 * Supports x402 v1 + v2 protocols, all EVM chains, EIP-3009 + Permit2.
 */

import { wrapFetchWithPayment, x402Client, x402HTTPClient } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { loadWallet } from './wallet.js';
import { createParaSigner } from './account.js';

const BASE_URL = process.env.SIGNAL402_URL || 'https://signal402.com';

// ── Lazy-Initialized Payment Client ─────────────

let _fetchWithPayment: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null = null;

// Per-request spending cap (safe in single-threaded Node.js)
let _currentMaxCost: number | undefined;

function getFetchWithPayment() {
  if (_fetchWithPayment) return _fetchWithPayment;

  const wallet = loadWallet();
  if (!wallet) throw new Error('No wallet configured. Run signal402_setup first.');

  // Create Para-backed signer that delegates to clara-proxy
  const signer = createParaSigner(wallet.walletId, wallet.address);

  // Initialize x402 client with EVM exact scheme (v1 + v2, all chains)
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });

  // Spending guard: abort payment if service costs more than max_cost
  client.onBeforePaymentCreation(async (context) => {
    if (_currentMaxCost != null) {
      const amount = context.selectedRequirements.maxAmountRequired;
      const costUsd = Number(amount) / 1e6; // USDC has 6 decimals
      if (costUsd > _currentMaxCost) {
        return {
          abort: true,
          reason: `Service costs $${costUsd.toFixed(4)} per request, exceeds max_cost of $${_currentMaxCost}. ` +
            `Increase max_cost or choose a cheaper service.`,
        };
      }
    }
  });

  _fetchWithPayment = wrapFetchWithPayment(globalThis.fetch, client);
  return _fetchWithPayment;
}

// ── Core Fetch ──────────────────────────────────

/**
 * Fetch a resource with automatic x402 payment handling.
 *
 * Uses the @x402 SDK for protocol-compliant 402 handling.
 * Optional maxCostUsd guard rejects payments above a threshold.
 */
export async function x402Fetch(
  url: string,
  init?: RequestInit,
  opts?: { maxCostUsd?: number }
): Promise<Response> {
  const payFetch = getFetchWithPayment();
  _currentMaxCost = opts?.maxCostUsd;
  try {
    return await payFetch(url, init);
  } finally {
    _currentMaxCost = undefined;
  }
}

// ── Public API ──────────────────────────────────

export async function fetchCatalog(params?: { category?: string; status?: string; sort?: string }): Promise<any> {
  const url = new URL('/catalog', BASE_URL);
  if (params?.category) url.searchParams.set('category', params.category);
  if (params?.status) url.searchParams.set('status', params.status);
  if (params?.sort) url.searchParams.set('sort', params.sort);

  const res = await x402Fetch(url.toString());
  if (!res.ok) throw new Error(`Catalog fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchAssess(query: { url?: string; name?: string }): Promise<any> {
  const res = await x402Fetch(`${BASE_URL}/assess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });

  if (!res.ok) throw new Error(`Assess fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchRecommend(params: {
  need: string;
  category?: string;
  max_price?: number;
  status?: string;
  limit?: number;
}): Promise<any> {
  const res = await x402Fetch(`${BASE_URL}/recommend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Recommend fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchProbe(params: {
  name?: string;
  url?: string;
}): Promise<any> {
  let target: string;
  if (params.url) {
    const probeUrl = new URL('/probe', BASE_URL);
    probeUrl.searchParams.set('url', params.url);
    target = probeUrl.toString();
  } else if (params.name) {
    target = `${BASE_URL}/probe/${encodeURIComponent(params.name)}`;
  } else {
    throw new Error('Provide either name or url');
  }

  const res = await x402Fetch(target);
  if (!res.ok) throw new Error(`Probe fetch failed: ${res.status}`);
  return res.json();
}
