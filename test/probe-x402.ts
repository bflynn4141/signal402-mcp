/**
 * Probe editorial services for native x402 support.
 *
 * Checks each service for:
 * 1. .well-known/x402 discovery endpoint
 * 2. 402 response on common API paths
 * 3. x402Version in any response body
 *
 * Run: cd ~/signal402/mcp && npx tsx test/probe-x402.ts
 */

const SERVICES = [
  { name: 'AIsa', url: 'https://aisa.bot' },
  { name: 'BlockRun.AI', url: 'https://blockrun.ai' },
  { name: 'AiMo', url: 'https://aimo.ai' },
  { name: 'x402engine', url: 'https://x402engine.com' },
  { name: 'Daydreams Inference', url: 'https://daydreams.ai' },
  { name: 'Imference', url: 'https://imference.ai' },
  { name: 'Genbase', url: 'https://genbase.ai' },
  { name: 'Venice.ai', url: 'https://venice.ai' },
  { name: 'Gloria AI', url: 'https://gloria.ai' },
  { name: 'AsterPay', url: 'https://asterpay.io' },
  { name: 'Einstein AI', url: 'https://einstein-ai.io' },
  { name: 'SLAMai', url: 'https://slamai.io' },
  { name: 'BlackSwan', url: 'https://blackswan.ai' },
  { name: 'Otto', url: 'https://otto.bot' },
  { name: 'Trusta.AI', url: 'https://trusta.ai' },
  { name: 'Agnic.AI', url: 'https://agnic.ai' },
  { name: 'MerchantGuard', url: 'https://merchantguard.io' },
  { name: 'Cybercentry', url: 'https://cybercentry.ai' },
  { name: 'Dune x402 Gateway', url: 'https://dune.com' },
  { name: 'Chainbase', url: 'https://chainbase.com' },
  { name: 'ClawdVine', url: 'https://clawdvine.com' },
  { name: 'Numbers Protocol', url: 'https://numbersprotocol.io' },
  { name: 'Kodo', url: 'https://kodo.ai' },
  { name: 'Akord', url: 'https://akord.com' },
  { name: 'Livepeer', url: 'https://livepeer.org' },
  { name: 'Firecrawl', url: 'https://firecrawl.dev' },
  { name: 'Minifetch', url: 'https://minifetch.dev' },
  { name: 'Zyte API', url: 'https://zyte.com' },
  { name: 'Pinata', url: 'https://pinata.cloud' },
  { name: 'Neynar', url: 'https://neynar.com' },
  { name: '402104', url: 'https://402104.xyz' },
  { name: 'tip.md', url: 'https://tip.md' },
  { name: 'dTelecom STT', url: 'https://dtelecom.org' },
  { name: 'Tweazy', url: 'https://tweazy.dev' },
  { name: 'x402secure', url: 'https://x402secure.com' },
  { name: 'agentlisa', url: 'https://agentlisa.ai' },
  { name: 'pay.codenut', url: 'https://pay.codenut.dev' },
  { name: 'Gelato Relay', url: 'https://gelato.network' },
  { name: 'Hyperlane', url: 'https://hyperlane.xyz' },
  { name: 'Stackr', url: 'https://stackrlabs.xyz' },
  { name: 'Phala Network', url: 'https://phala.network' },
  { name: 'Fleek Functions', url: 'https://fleek.xyz' },
  { name: 'Synternet', url: 'https://synternet.com' },
  { name: 'Space and Time', url: 'https://spaceandtime.io' },
];

// Common API prefixes to try on each domain
const API_PATHS = [
  '/.well-known/x402',
  '/api',
  '/api/v1',
  '/api/v2',
  '/v1',
  '/v2',
];

interface ProbeResult {
  name: string;
  url: string;
  has_wellknown: boolean;
  x402_endpoints: string[];      // paths that returned 402
  x402_version?: number;
  payment_details?: any;
  error?: string;
}

async function probeService(service: { name: string; url: string }): Promise<ProbeResult> {
  const origin = service.url.replace(/\/$/, '');
  const result: ProbeResult = {
    name: service.name,
    url: service.url,
    has_wellknown: false,
    x402_endpoints: [],
  };

  // Check all paths concurrently with timeout
  const checks = API_PATHS.map(async (path) => {
    const fullUrl = `${origin}${path}`;
    try {
      const res = await fetch(fullUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      });

      if (path === '/.well-known/x402' && res.ok) {
        result.has_wellknown = true;
        try {
          const body = await res.json() as any;
          if (body?.endpoints || Array.isArray(body)) {
            const eps = Array.isArray(body) ? body : body.endpoints;
            result.x402_endpoints.push(...eps.map((e: any) => typeof e === 'string' ? e : e.url || e.endpoint));
          }
        } catch { /* not JSON */ }
        return;
      }

      if (res.status === 402) {
        result.x402_endpoints.push(fullUrl);
        try {
          const body = await res.json() as any;
          if (body?.x402Version) {
            result.x402_version = body.x402Version;
            result.payment_details = {
              scheme: body.accepts?.[0]?.scheme,
              amount: body.accepts?.[0]?.maxAmountRequired || body.accepts?.[0]?.amount,
              asset: body.accepts?.[0]?.asset,
              network: body.accepts?.[0]?.network,
              payTo: body.accepts?.[0]?.payTo,
            };
          }
        } catch { /* not JSON */ }
      }
    } catch {
      // Timeout or DNS failure — skip silently
    }
  });

  try {
    await Promise.all(checks);
  } catch (err: any) {
    result.error = err.message;
  }

  return result;
}

async function main() {
  console.log('Probing 44 editorial services for native x402 support...\n');
  console.log('Checking: .well-known/x402 + 5 common API paths per service');
  console.log('Timeout: 5s per request\n');

  const startTime = performance.now();

  // Run probes in batches of 5 to avoid overwhelming
  const results: ProbeResult[] = [];
  const batchSize = 5;

  for (let i = 0; i < SERVICES.length; i += batchSize) {
    const batch = SERVICES.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(probeService));

    for (const r of batchResults) {
      results.push(r);
      const icon = r.x402_endpoints.length > 0 || r.has_wellknown ? '✓ x402' : '  ---';
      const detail = r.x402_endpoints.length > 0
        ? `${r.x402_endpoints.length} endpoint(s), v${r.x402_version || '?'}`
        : r.has_wellknown ? '.well-known/x402 found' : '';
      console.log(`${icon}  ${r.name.padEnd(25)} ${detail}`);
    }
  }

  const elapsed = Math.round(performance.now() - startTime);

  // Summary
  const x402Services = results.filter(r => r.x402_endpoints.length > 0 || r.has_wellknown);

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Probed ${results.length} services in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`Found ${x402Services.length} with native x402 support:\n`);

  for (const s of x402Services) {
    console.log(`  ${s.name}`);
    if (s.has_wellknown) console.log(`    .well-known/x402: YES`);
    for (const ep of s.x402_endpoints) {
      console.log(`    402 endpoint: ${ep}`);
    }
    if (s.payment_details) {
      const pd = s.payment_details;
      const amountNum = parseInt(pd.amount || '0', 10);
      const usdPrice = amountNum / 1_000_000; // USDC has 6 decimals
      console.log(`    Price: $${usdPrice.toFixed(4)} (${pd.scheme}, ${pd.network})`);
      console.log(`    Pay to: ${pd.payTo}`);
    }
    console.log();
  }
}

main().catch(console.error);
