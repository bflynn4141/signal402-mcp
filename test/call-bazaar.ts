/**
 * Quick test: Call a real Bazaar x402 service through our payment client.
 * Tests the full loop: request → 402 → sign payment → retry → paid response.
 *
 * Run: cd ~/signal402/mcp && npx tsx test/call-bazaar.ts
 */

import { x402Fetch } from '../src/client.js';
import { loadWallet } from '../src/wallet.js';

const TARGETS = [
  {
    name: 'emc2ai — Pumpfun Launches',
    url: 'https://emc2ai.io/x402/bitquery/pumpfun-launches/raw',
    method: 'POST',
    body: { limit: '3', timeperiod: '24h' },
    maxCost: 0.70,
    expectedCost: 0.60,
  },
  {
    name: 'Silverback — Trending Tokens',
    url: 'https://x402.silverbackdefi.app/api/v1/trending-tokens?chain=base',
    method: 'GET',
    body: null,
    maxCost: 0.01,
    expectedCost: 0.005,
  },
];

async function main() {
  const wallet = loadWallet();
  if (!wallet) {
    console.error('No wallet configured');
    process.exit(1);
  }
  console.log(`Wallet: ${wallet.address}\n`);

  for (const target of TARGETS) {
    console.log(`── ${target.name} ──`);
    console.log(`   URL: ${target.url}`);
    console.log(`   Expected cost: $${target.expectedCost}`);
    console.log(`   Max cost cap:  $${target.maxCost}`);

    const start = Date.now();
    try {
      const res = await x402Fetch(
        target.url,
        {
          method: target.method,
          ...(target.body
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(target.body),
              }
            : {}),
        },
        { maxCostUsd: target.maxCost },
      );

      const elapsed = Date.now() - start;
      console.log(`   Status: ${res.status} (${elapsed}ms)`);

      if (res.ok) {
        const text = await res.text();
        console.log(`   ✓ SUCCESS — paid x402 call!`);
        console.log(`   Response preview: ${text.slice(0, 200)}...`);
      } else {
        const text = await res.text();
        console.log(`   ✗ Failed: ${text.slice(0, 200)}`);
      }
    } catch (err: any) {
      const elapsed = Date.now() - start;
      console.log(`   ✗ Error (${elapsed}ms): ${err.message?.slice(0, 200)}`);
    }
    console.log();
  }
}

main();
