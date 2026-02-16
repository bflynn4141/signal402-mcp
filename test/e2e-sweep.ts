/**
 * E2E Sweep: signal402_recommend → signal402_call
 *
 * Validates the full discover→call loop against real x402 services:
 *   Phase 1: Catalog snapshot
 *   Phase 2: Recommend sweep (15 queries)
 *   Phase 3: Probe liveness check (top 5 services)
 *   Phase 4: Call sweep (services with callable endpoints)
 *   Phase 5: Edge case tests (spending guard, non-x402, bad URL)
 *
 * Budget: ~$0.54 estimated, hard cap $1.00
 *
 * Run: cd ~/signal402/mcp && npx tsx test/e2e-sweep.ts
 */

// ── Debug Logging (optional) ──────────────────────
//
// Set DEBUG_X402=1 to see x402 payment flow details.
// The compatibility shim that was here has been removed — Signal402 worker
// now speaks standard PAYMENT-REQUIRED headers and accepts v2 payloads natively.
//
const DEBUG = process.env.DEBUG_X402 === '1';

import { x402Fetch, fetchCatalog, fetchRecommend, fetchProbe } from '../src/client.js';
import { loadWallet } from '../src/wallet.js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Types ────────────────────────────────────────

interface EndpointSchema {
  url: string;
  method: string;
  bodyType?: string;
  bodyFields?: Record<string, { type: string; required?: boolean; description?: string }>;
  queryParams?: Record<string, { type: string; required?: boolean; description?: string }>;
  description: string;
  price_usd: number;
}

interface QueryResult {
  query: string;
  category?: string;
  results: Array<{
    name: string;
    url: string;
    bazaar_resource_url?: string;
    source?: string;
    endpoints?: EndpointSchema[];
    score?: number;
    price?: number;
  }>;
  expected_match: string;
  matched: boolean;
  has_endpoint: boolean;
  latency_ms: number;
  cost: number;
  error: string | null;
}

interface ProbeResult {
  service: string;
  url: string;
  alive: boolean;
  response_time_ms: number;
  price_confirmed: number | null;
  error: string | null;
}

interface CallResult {
  service: string;
  endpoint: string;
  method: string;
  http_status: number;
  paid: boolean;
  response_preview: string;
  error: string | null;
  latency_ms: number;
  cost_usd: number;
}

interface EdgeCaseResult {
  passed: boolean;
  error_message: string;
  status?: number;
}

interface TestResults {
  meta: {
    timestamp: string;
    wallet_address: string;
    sdk_version: string;
    total_cost_usd: number;
    duration_ms: number;
  };
  catalog: { total: number; categories: Record<string, number> };
  recommend: {
    total: number;
    matched: number;
    with_endpoints: number;
    queries: QueryResult[];
  };
  probe: {
    total: number;
    alive: number;
    results: ProbeResult[];
  };
  calls: {
    total: number;
    succeeded: number;
    paid: number;
    failed: number;
    results: CallResult[];
  };
  edge_cases: {
    spending_guard: EdgeCaseResult;
    non_x402_passthrough: EdgeCaseResult;
    bad_url: EdgeCaseResult;
  };
  findings: string[];
  summary: {
    recommend_accuracy: string;
    endpoint_coverage: string;
    call_success_rate: string;
    total_cost: string;
    verdict: 'PASS' | 'PARTIAL' | 'FAIL';
  };
}

// ── Test Matrix ──────────────────────────────────

const TEST_QUERIES: Array<{
  query: string;
  category?: string;
  expected: string;
}> = [
  { query: 'web scraping', category: 'tools', expected: 'Firecrawl' },
  { query: 'IPFS pinning and storage', category: 'tools', expected: 'Pinata' },
  { query: 'text generation LLM', category: 'ai', expected: 'x402engine' },
  { query: 'image generation', category: 'ai', expected: 'Imference' },
  { query: 'crypto news and market data', category: 'data', expected: 'Gloria' },
  { query: 'token prices on-chain', category: 'data', expected: 'AsterPay' },
  { query: 'smart contract security audit', category: 'data', expected: 'Cybercentry' },
  { query: 'video generation', category: 'media', expected: 'ClawdVine' },
  { query: 'twitter API proxy', category: 'infra', expected: 'Tweazy' },
  { query: 'speech to text transcription', category: 'infra', expected: 'dTelecom' },
  { query: 'farcaster social API', category: 'tools', expected: 'Neynar' },
  { query: 'social media listening', category: 'data', expected: 'SLAMai' },
  { query: 'wallet reputation sybil', category: 'data', expected: 'Trusta' },
  { query: 'privacy AI inference', category: 'ai', expected: 'Venice' },
  { query: 'permanent decentralized storage', category: 'tools', expected: 'Akord' },
  { query: 'contact enrichment and people search', category: 'data', expected: 'EnrichX402' },
  { query: 'AI image and video generation', category: 'media', expected: 'StableStudio' },
  { query: 'x402 ecosystem explorer and analytics', category: 'data', expected: 'x402scan' },
];

// Known callable endpoints for editorial-only services (fallback when no bazaar_resource_url)
const KNOWN_ENDPOINTS: Record<string, { url: string; method: string; body?: string; max_cost: number }> = {
  'Firecrawl': {
    url: 'https://api.firecrawl.dev/v1/scrape',
    method: 'POST',
    body: JSON.stringify({ url: 'https://example.com' }),
    max_cost: 0.05,
  },
  'Neynar': {
    url: 'https://api.neynar.com/v2/farcaster/cast?type=url&identifier=https://warpcast.com/horsefacts.eth/0x6b8e99f5',
    method: 'GET',
    max_cost: 0.01, // $0.001 USDC (x402v1)
  },
  'BlockRun.AI': {
    url: 'https://blockrun.ai/api/v1/chat/completions',
    method: 'POST',
    body: JSON.stringify({
      model: 'openai/gpt-5-nano',
      messages: [{ role: 'user', content: 'Say hello in one word.' }],
      max_tokens: 16,
    }),
    max_cost: 0.01, // $0.001 USDC (x402v2)
  },
  'Tweazy': {
    url: 'https://api.tweazy.com/search?q=x402',
    method: 'GET',
    max_cost: 0.01,
  },
  'Gloria AI': {
    url: 'https://api.gloriaai.com/query',
    method: 'POST',
    body: JSON.stringify({ q: 'bitcoin price' }),
    max_cost: 0.01,
  },
  'Pinata': {
    url: 'https://api.pinata.cloud/pinning/pinJSONToIPFS',
    method: 'POST',
    body: JSON.stringify({ pinataContent: { test: 'signal402-e2e-sweep' } }),
    max_cost: 0.01,
  },
  'EnrichX402': {
    url: 'https://enrichx402.com/api/exa/search',
    method: 'POST',
    body: JSON.stringify({ query: 'x402 protocol', numResults: 2 }),
    max_cost: 0.02, // $0.01 per Exa search
  },
  'StableStudio': {
    url: 'https://stablestudio.io/api/x402/nano-banana/generate',
    method: 'POST',
    body: JSON.stringify({ prompt: 'A simple blue circle on white background', aspectRatio: '1:1' }),
    max_cost: 0.05, // $0.039 for nano-banana
  },
  'x402scan': {
    url: 'https://www.x402scan.com/api/data/facilitators',
    method: 'GET',
    max_cost: 0.02, // $0.01 per data query
  },
};

// ── Helpers ───────────────────────────────────────

function log(phase: string, msg: string) {
  const ts = new Date().toISOString().split('T')[1]!.slice(0, 12);
  console.log(`[${ts}] [${phase}] ${msg}`);
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

/** Check if expected service name appears in top N results (case-insensitive partial match) */
function matchesExpected(results: Array<{ name: string }>, expected: string, topN = 3): boolean {
  const needle = expected.toLowerCase();
  return results.slice(0, topN).some(r => r.name.toLowerCase().includes(needle));
}

/** Try .well-known/x402 discovery on a domain */
async function discoverEndpoints(origin: string): Promise<Array<{ url: string; method: string }>> {
  try {
    const res = await fetch(`${origin}/.well-known/x402`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    // .well-known/x402 may return { endpoints: [...] } or an array directly
    const endpoints = Array.isArray(data) ? data : data?.endpoints;
    if (!Array.isArray(endpoints)) return [];
    return endpoints.map((e: any) => ({
      url: typeof e === 'string' ? e : e.url || e.endpoint,
      method: e.method || 'GET',
    }));
  } catch {
    return [];
  }
}

// ── Phase 1: Catalog Snapshot ─────────────────────

async function phase1_catalog(): Promise<TestResults['catalog']> {
  log('CATALOG', 'Fetching full catalog...');
  const start = performance.now();

  try {
    const data = await fetchCatalog();
    const services = Array.isArray(data) ? data : data?.services || data?.results || [];
    const categories: Record<string, number> = {};
    for (const s of services) {
      const cat = s.category || 'unknown';
      categories[cat] = (categories[cat] || 0) + 1;
    }

    log('CATALOG', `Got ${services.length} services in ${elapsed(start)}ms — ${Object.entries(categories).map(([k, v]) => `${k}:${v}`).join(', ')}`);
    return { total: services.length, categories };
  } catch (err: any) {
    log('CATALOG', `ERROR: ${err.message}`);
    return { total: 0, categories: {} };
  }
}

// ── Phase 2: Recommend Sweep ──────────────────────

async function phase2_recommend(): Promise<TestResults['recommend']> {
  log('RECOMMEND', `Running ${TEST_QUERIES.length} queries...`);
  const queries: QueryResult[] = [];
  let matched = 0;
  let withEndpoints = 0;

  for (const tq of TEST_QUERIES) {
    const start = performance.now();
    let result: QueryResult;

    try {
      const data = await fetchRecommend({
        need: tq.query,
        category: tq.category,
        limit: 5,
      });

      // Normalize response — might be array or { results: [...] } or { recommendations: [...] }
      const results = Array.isArray(data) ? data : data?.results || data?.recommendations || data?.services || [];

      const normalized = results.map((r: any) => ({
        name: r.name || r.service || 'unknown',
        url: r.url || r.website || '',
        bazaar_resource_url: r.bazaar_resource_url || r.bazaar_url || r.endpoint || undefined,
        source: r.source || undefined,
        endpoints: r.endpoints || undefined,
        score: r.score ?? r.relevance ?? undefined,
        price: r.price ?? r.cost ?? r.price_per_request ?? undefined,
      }));

      const isMatched = matchesExpected(normalized, tq.expected);
      const hasEndpoint = normalized.some((r: any) => r.bazaar_resource_url || r.endpoints?.length);

      if (isMatched) matched++;
      if (hasEndpoint) withEndpoints++;

      result = {
        query: tq.query,
        category: tq.category,
        results: normalized,
        expected_match: tq.expected,
        matched: isMatched,
        has_endpoint: hasEndpoint,
        latency_ms: elapsed(start),
        cost: 0.02,
        error: null,
      };

      const topName = normalized[0]?.name || '(empty)';
      const matchIcon = isMatched ? '✓' : '✗';
      log('RECOMMEND', `${matchIcon} "${tq.query}" → ${topName} (expected: ${tq.expected}) [${elapsed(start)}ms]`);
    } catch (err: any) {
      result = {
        query: tq.query,
        category: tq.category,
        results: [],
        expected_match: tq.expected,
        matched: false,
        has_endpoint: false,
        latency_ms: elapsed(start),
        cost: 0.02,
        error: err.message,
      };
      log('RECOMMEND', `✗ "${tq.query}" ERROR: ${err.message}`);
    }

    queries.push(result);
  }

  log('RECOMMEND', `Done: ${matched}/${TEST_QUERIES.length} matched, ${withEndpoints} with endpoints`);
  return { total: TEST_QUERIES.length, matched, with_endpoints: withEndpoints, queries };
}

// ── Phase 3: Probe Check ─────────────────────────

async function phase3_probe(recommendResults: QueryResult[]): Promise<TestResults['probe']> {
  // Collect unique services that have callable endpoints or are in known endpoints map
  const seen = new Set<string>();
  const toProbe: Array<{ name: string; url: string }> = [];

  for (const q of recommendResults) {
    for (const r of q.results) {
      if (seen.has(r.name)) continue;
      if (r.bazaar_resource_url || KNOWN_ENDPOINTS[r.name]) {
        seen.add(r.name);
        toProbe.push({ name: r.name, url: r.url || r.bazaar_resource_url || '' });
      }
    }
    if (toProbe.length >= 5) break;
  }

  log('PROBE', `Probing ${toProbe.length} services...`);
  const results: ProbeResult[] = [];
  let alive = 0;

  for (const svc of toProbe) {
    const start = performance.now();
    try {
      const data = await fetchProbe({ name: svc.name });
      const isAlive = data?.healthy ?? data?.alive ?? data?.status === 'live' ?? false;
      if (isAlive) alive++;

      results.push({
        service: svc.name,
        url: svc.url,
        alive: isAlive,
        response_time_ms: data?.response_time_ms ?? data?.responseTime ?? elapsed(start),
        price_confirmed: data?.pricing?.per_request ?? data?.price ?? null,
        error: null,
      });

      const icon = isAlive ? '✓' : '✗';
      log('PROBE', `${icon} ${svc.name} — alive:${isAlive} [${elapsed(start)}ms]`);
    } catch (err: any) {
      results.push({
        service: svc.name,
        url: svc.url,
        alive: false,
        response_time_ms: elapsed(start),
        price_confirmed: null,
        error: err.message,
      });
      log('PROBE', `✗ ${svc.name} ERROR: ${err.message}`);
    }
  }

  log('PROBE', `Done: ${alive}/${toProbe.length} alive`);
  return { total: toProbe.length, alive, results };
}

/**
 * Sensible default values for common field names in x402 API requests.
 */
const FIELD_DEFAULTS: Record<string, any> = {
  // Pagination / limits
  limit: 5,
  count: 5,
  page: 1,
  offset: 0,
  // Time
  timeperiod: '24h',
  duration: '7d',
  period: '24h',
  interval: '1h',
  // Blockchain
  chain: 'base',
  chainId: 8453,
  network: 'base',
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base (token, not wallet)
  wallet: '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd',
  walletAddress: '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd',
  tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  txHash: '0x8006e139dac21595530fdb5b8166ecc607c0ec94e797256573eaaa1c2c076e4f',
  hash: '0x8006e139dac21595530fdb5b8166ecc607c0ec94e797256573eaaa1c2c076e4f',
  data: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  // Text
  content: 'Hello, this is a test message.',
  text: 'Hello, this is a test message.',
  query: 'ethereum',
  q: 'ethereum',
  search: 'ethereum',
  prompt: 'Say hello in one sentence.',
  message: 'Hello',
  // URLs
  url: 'https://example.com',
  // AI models
  model: 'gpt-3.5-turbo',
  // Booleans
  includeMetadata: true,
  verbose: false,
};

/**
 * Get a default value for a schema field, using field name first, then type fallback.
 */
function getFieldDefault(key: string, field: { type: string }): any {
  if (key in FIELD_DEFAULTS) return FIELD_DEFAULTS[key];
  // Type fallback
  if (field.type === 'string') return 'test';
  if (field.type === 'number' || field.type === 'integer') return 1;
  if (field.type === 'boolean') return true;
  return 'test';
}

/**
 * Build a request body from a Bazaar endpoint schema (POST/PUT only).
 */
function buildRequestBody(ep: EndpointSchema): string | undefined {
  if (ep.method === 'GET') return undefined;
  if (!ep.bodyFields || ep.bodyType !== 'json') return undefined;

  const body: Record<string, any> = {};
  for (const [key, field] of Object.entries(ep.bodyFields)) {
    body[key] = getFieldDefault(key, field);
  }

  return Object.keys(body).length > 0 ? JSON.stringify(body) : undefined;
}

/**
 * Build query string from a Bazaar endpoint schema (GET only).
 * Only includes params we have mapped defaults for — avoids sending
 * garbage like `category=test` that breaks services.
 * Returns the query string including leading '?' or empty string.
 */
function buildQueryString(ep: EndpointSchema): string {
  if (!ep.queryParams || Object.keys(ep.queryParams).length === 0) return '';

  const params = new URLSearchParams();
  for (const [key, field] of Object.entries(ep.queryParams)) {
    // Only include params we have an explicit mapping for.
    // Sending "test" for unknown params is worse than omitting them.
    if (key in FIELD_DEFAULTS) {
      params.set(key, String(FIELD_DEFAULTS[key]));
    } else if (field.required) {
      // For required params without a mapping, use type-appropriate minimal values
      if (field.type === 'number' || field.type === 'integer') params.set(key, '1');
      else if (field.type === 'boolean') params.set(key, 'true');
      // Skip unknown required strings — better to get a clear error than send "test"
    }
  }

  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// ── Phase 4: Call Sweep ──────────────────────────

async function phase4_calls(
  recommendResults: QueryResult[],
  probeResults: ProbeResult[],
): Promise<TestResults['calls']> {
  // Build call targets from Bazaar endpoints with proper schemas.
  // Skip editorial-only services (they require API keys, not x402).
  const callTargets: Array<{
    service: string;
    endpoint: string;
    method: string;
    body?: string;
    max_cost: number;
    source: string;
  }> = [];

  const seen = new Set<string>();

  // First pass: Bazaar services with endpoint schemas (best data)
  for (const q of recommendResults) {
    for (const r of q.results) {
      if (seen.has(r.name)) continue;
      if (r.endpoints?.length) {
        seen.add(r.name);
        // Pick the cheapest endpoint, preferring GET (simpler to test)
        const sorted = [...r.endpoints].sort((a, b) => {
          if (a.method === 'GET' && b.method !== 'GET') return -1;
          if (b.method === 'GET' && a.method !== 'GET') return 1;
          return a.price_usd - b.price_usd;
        });
        const ep = sorted[0]!;
        // For GET endpoints, append query params from schema to URL
        const qs = ep.method === 'GET' ? buildQueryString(ep) : '';
        callTargets.push({
          service: r.name,
          endpoint: ep.url + qs,
          method: ep.method,
          body: buildRequestBody(ep),
          max_cost: Math.max(ep.price_usd * 1.2, 0.01), // 20% buffer
          source: 'bazaar-schema',
        });
      }
    }
  }

  // Second pass: bazaar_resource_url without endpoint schemas
  for (const q of recommendResults) {
    for (const r of q.results) {
      if (seen.has(r.name)) continue;
      if (r.bazaar_resource_url && r.source !== 'editorial') {
        seen.add(r.name);
        callTargets.push({
          service: r.name,
          endpoint: r.bazaar_resource_url,
          method: 'GET',
          max_cost: 0.10,
          source: 'bazaar-url',
        });
      }
    }
  }

  // Third pass: known editorial endpoints (includes native x402 services like Neynar, BlockRun)
  for (const q of recommendResults) {
    if (callTargets.length >= 20) break;
    for (const r of q.results) {
      if (seen.has(r.name)) continue;
      const known = KNOWN_ENDPOINTS[r.name];
      if (!known) continue;
      seen.add(r.name);
      callTargets.push({
        service: r.name,
        endpoint: known.url,
        method: known.method,
        body: known.body,
        max_cost: known.max_cost,
        source: 'editorial-known',
      });
    }
  }

  log('CALL', `Calling ${callTargets.length} services...`);
  const results: CallResult[] = [];
  let succeeded = 0;
  let paid = 0;
  let failed = 0;

  for (const target of callTargets) {
    const start = performance.now();
    try {
      const init: RequestInit = {
        method: target.method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (target.body && target.method !== 'GET') {
        init.body = target.body;
      }

      const res = await x402Fetch(target.endpoint, init, { maxCostUsd: target.max_cost });
      const status = res.status;
      // Detect if payment happened: check for x402-specific response headers
      const didPay = res.headers.has('x-payment') ||
        res.headers.has('x-receipt') ||
        res.headers.has('x402-payment-receipt');

      let preview = '';
      try {
        const text = await res.text();
        preview = text.slice(0, 200);
      } catch {
        preview = '(could not read body)';
      }

      const isSuccess = status >= 200 && status < 400;
      if (isSuccess) succeeded++;
      if (didPay) paid++;
      if (!isSuccess) failed++;

      results.push({
        service: target.service,
        endpoint: target.endpoint,
        method: target.method,
        http_status: status,
        paid: didPay,
        response_preview: preview,
        error: isSuccess ? null : `HTTP ${status}`,
        latency_ms: elapsed(start),
        cost_usd: didPay ? target.max_cost : 0,
      });

      const icon = isSuccess ? '✓' : '✗';
      const payIcon = didPay ? ' 💰' : '';
      log('CALL', `${icon} ${target.service} → ${status}${payIcon} [${elapsed(start)}ms]`);
    } catch (err: any) {
      failed++;
      results.push({
        service: target.service,
        endpoint: target.endpoint,
        method: target.method,
        http_status: 0,
        paid: false,
        response_preview: '',
        error: err.message,
        latency_ms: elapsed(start),
        cost_usd: 0,
      });
      log('CALL', `✗ ${target.service} ERROR: ${err.message}`);
    }
  }

  log('CALL', `Done: ${succeeded} succeeded, ${paid} paid, ${failed} failed`);
  return { total: callTargets.length, succeeded, paid, failed, results };
}

// ── Phase 5: Edge Cases ──────────────────────────

async function phase5_edge_cases(): Promise<TestResults['edge_cases']> {
  log('EDGE', 'Running edge case tests...');

  // Test 1: Spending guard — set absurdly low max_cost, should reject before signing
  let spendingGuard: EdgeCaseResult;
  try {
    // Use a known x402 endpoint (Signal402 catalog itself costs $0.01)
    const BASE_URL = process.env.SIGNAL402_URL || 'https://signal402.com';
    await x402Fetch(`${BASE_URL}/catalog`, undefined, { maxCostUsd: 0.0001 });
    // If we got here without error, the guard didn't fire (endpoint might not be 402)
    spendingGuard = { passed: false, error_message: 'No spending guard triggered — endpoint may not require payment' };
    log('EDGE', '? spending_guard — no 402 triggered (might be cached or free)');
  } catch (err: any) {
    // We EXPECT an error here — the guard should abort
    const msg = err.message || String(err);
    const guardTriggered = msg.includes('exceeds max_cost') || msg.includes('abort');
    spendingGuard = {
      passed: guardTriggered,
      error_message: msg,
    };
    log('EDGE', `${guardTriggered ? '✓' : '✗'} spending_guard — ${msg.slice(0, 80)}`);
  }

  // Test 2: Non-x402 URL — should pass through as normal fetch (200)
  let nonX402: EdgeCaseResult;
  try {
    const res = await x402Fetch('https://httpbin.org/get');
    nonX402 = {
      passed: res.status === 200,
      error_message: res.status === 200 ? 'Passthrough OK' : `Unexpected status: ${res.status}`,
      status: res.status,
    };
    log('EDGE', `${res.status === 200 ? '✓' : '✗'} non_x402_passthrough → ${res.status}`);
  } catch (err: any) {
    nonX402 = { passed: false, error_message: err.message, status: 0 };
    log('EDGE', `✗ non_x402_passthrough ERROR: ${err.message}`);
  }

  // Test 3: Bad URL — should return network error gracefully
  let badUrl: EdgeCaseResult;
  try {
    await x402Fetch('https://nonexistent.x402service.invalid/api');
    badUrl = { passed: false, error_message: 'Expected network error but got response' };
    log('EDGE', '✗ bad_url — expected error but got response');
  } catch (err: any) {
    const msg = err.message || String(err);
    badUrl = { passed: true, error_message: msg };
    log('EDGE', `✓ bad_url — ${msg.slice(0, 60)}`);
  }

  return {
    spending_guard: spendingGuard,
    non_x402_passthrough: nonX402,
    bad_url: badUrl,
  };
}

// ── Summary & Verdict ────────────────────────────

function computeSummary(results: Omit<TestResults, 'summary'>): TestResults['summary'] {
  const recAcc = `${results.recommend.matched}/${results.recommend.total}`;
  const endCov = `${results.recommend.with_endpoints}/${results.recommend.total}`;
  const callRate = results.calls.total > 0
    ? `${results.calls.succeeded}/${results.calls.total}`
    : '0/0';

  // Estimate total cost
  const recommendCost = results.recommend.queries.reduce((sum, q) => sum + q.cost, 0);
  const probeCost = results.probe.total * 0.01;
  const callCost = results.calls.results.reduce((sum, c) => sum + c.cost_usd, 0);
  const catalogCost = 0.01;
  const totalCost = recommendCost + probeCost + callCost + catalogCost;

  // Verdict logic
  const edgePassed = [
    results.edge_cases.spending_guard.passed,
    results.edge_cases.non_x402_passthrough.passed,
    results.edge_cases.bad_url.passed,
  ].filter(Boolean).length;

  let verdict: 'PASS' | 'PARTIAL' | 'FAIL';
  if (
    results.recommend.matched >= 10 &&
    results.calls.succeeded >= 1 &&
    edgePassed >= 2
  ) {
    verdict = 'PASS';
  } else if (
    results.recommend.matched >= 5 &&
    edgePassed >= 1
  ) {
    verdict = 'PARTIAL';
  } else {
    verdict = 'FAIL';
  }

  const recPct = results.recommend.total > 0
    ? Math.round((results.recommend.matched / results.recommend.total) * 100)
    : 0;
  const endPct = results.recommend.total > 0
    ? Math.round((results.recommend.with_endpoints / results.recommend.total) * 100)
    : 0;
  const callPct = results.calls.total > 0
    ? Math.round((results.calls.succeeded / results.calls.total) * 100)
    : 0;

  return {
    recommend_accuracy: `${recAcc} (${recPct}%)`,
    endpoint_coverage: `${endCov} (${endPct}%)`,
    call_success_rate: `${callRate} (${callPct}%)`,
    total_cost: `$${totalCost.toFixed(2)}`,
    verdict,
  };
}

// ── Pretty Print ─────────────────────────────────

function printSummaryTable(results: TestResults) {
  console.log('\n');
  console.log('┌─────────────────────────────────────────────────┐');
  console.log('│         E2E SWEEP — RESULTS SUMMARY             │');
  console.log('├─────────────────────────────────────────────────┤');
  console.log(`│  Recommend accuracy:  ${results.summary.recommend_accuracy.padEnd(26)}│`);
  console.log(`│  Endpoint coverage:   ${results.summary.endpoint_coverage.padEnd(26)}│`);
  console.log(`│  Call success rate:   ${results.summary.call_success_rate.padEnd(26)}│`);
  console.log(`│  Total cost:          ${results.summary.total_cost.padEnd(26)}│`);
  console.log(`│  Duration:            ${(results.meta.duration_ms / 1000).toFixed(1).padEnd(22)}sec │`);
  console.log('├─────────────────────────────────────────────────┤');

  // Edge cases
  const sg = results.edge_cases.spending_guard.passed ? '✓ PASS' : '✗ FAIL';
  const np = results.edge_cases.non_x402_passthrough.passed ? '✓ PASS' : '✗ FAIL';
  const bu = results.edge_cases.bad_url.passed ? '✓ PASS' : '✗ FAIL';
  console.log(`│  Spending guard:      ${sg.padEnd(26)}│`);
  console.log(`│  Non-x402 passthrough:${np.padEnd(26)}│`);
  console.log(`│  Bad URL handling:    ${bu.padEnd(26)}│`);
  console.log('├─────────────────────────────────────────────────┤');

  // Calls detail
  if (results.calls.results.length > 0) {
    console.log('│  CALL RESULTS:                                  │');
    for (const c of results.calls.results) {
      const icon = c.http_status >= 200 && c.http_status < 400 ? '✓' : '✗';
      const pay = c.paid ? '💰' : '  ';
      const line = `  ${icon} ${pay} ${c.service.padEnd(16)} ${String(c.http_status).padEnd(4)} ${c.latency_ms}ms`;
      console.log(`│${line.padEnd(49)}│`);
    }
    console.log('├─────────────────────────────────────────────────┤');
  }

  // Findings
  if (results.findings.length > 0) {
    console.log('│  FINDINGS:                                      │');
    for (const f of results.findings) {
      const tag = f.split(':')[0]!;
      console.log(`│  - ${tag.padEnd(44)}│`);
    }
    console.log('├─────────────────────────────────────────────────┤');
  }

  // Verdict
  const verdictColor = results.summary.verdict === 'PASS' ? '✅' :
    results.summary.verdict === 'PARTIAL' ? '⚠️' : '❌';
  console.log(`│  VERDICT: ${verdictColor} ${results.summary.verdict.padEnd(36)}│`);
  console.log('└─────────────────────────────────────────────────┘');
}

// ── Main ─────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Signal402 E2E Sweep — recommend → call');
  console.log('  Budget: $1.00 hard cap');
  console.log('═══════════════════════════════════════════════════\n');

  // Preflight: check wallet exists
  const wallet = loadWallet();
  if (!wallet) {
    console.error('ERROR: No wallet found at ~/.signal402/wallet.json');
    console.error('Run: npx tsx src/cli.ts setup');
    process.exit(1);
  }
  log('INIT', `Wallet: ${wallet.address}`);

  const sweepStart = performance.now();

  // Phase 1
  console.log('\n── Phase 1: Catalog Snapshot ────────────────────\n');
  const catalog = await phase1_catalog();

  // Phase 2
  console.log('\n── Phase 2: Recommend Sweep ─────────────────────\n');
  const recommend = await phase2_recommend();

  // Phase 3
  console.log('\n── Phase 3: Probe Check ─────────────────────────\n');
  const probe = await phase3_probe(recommend.queries);

  // Phase 4
  console.log('\n── Phase 4: Call Sweep ──────────────────────────\n');
  const calls = await phase4_calls(recommend.queries, probe.results);

  // Phase 5
  console.log('\n── Phase 5: Edge Cases ──────────────────────────\n');
  const edge_cases = await phase5_edge_cases();

  const durationMs = elapsed(sweepStart);

  // Collect findings (dynamic — based on actual results)
  const findings: string[] = [];

  // Add dynamic findings based on results
  const mismatched = recommend.queries.filter((q: any) => !q.matched);
  if (mismatched.length > 0) {
    findings.push(`MISRANKED: ${mismatched.length} queries returned unexpected top result: ${mismatched.map((q: any) => `"${q.query}" → ${q.results?.[0]?.name || 'empty'} (expected ${q.expected_match})`).join('; ')}`);
  }

  const non402Fails = calls.results.filter(c => c.http_status === 401 || c.http_status === 403);
  if (non402Fails.length > 0) {
    findings.push(`NO-X402-PAYWALL: ${non402Fails.map(c => c.service).join(', ')} returned ${non402Fails.map(c => c.http_status).join('/')}, not 402. These endpoints require API keys, not x402 payments.`);
  }

  if (recommend.with_endpoints === 0) {
    findings.push('NO-BAZAAR-URLS: Zero services returned bazaar_resource_url in recommend results. All catalog entries are editorial-only — need Bazaar enrichment or .well-known/x402 support.');
  }

  // Build results (without summary first, to compute it)
  const partialResults = {
    meta: {
      timestamp: new Date().toISOString(),
      wallet_address: wallet.address,
      sdk_version: '0.4.0',
      total_cost_usd: 0, // filled below
      duration_ms: durationMs,
    },
    catalog,
    recommend,
    probe,
    calls,
    edge_cases,
    findings,
  };

  const summary = computeSummary(partialResults);
  const costNum = parseFloat(summary.total_cost.replace('$', ''));
  partialResults.meta.total_cost_usd = costNum;

  const results: TestResults = { ...partialResults, summary };

  // Write results JSON
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = join(__dirname, '..', 'test-results.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  log('DONE', `Results written to ${outPath}`);

  // Pretty print
  printSummaryTable(results);

  // Exit code based on verdict
  if (results.summary.verdict === 'FAIL') {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
