/**
 * Fetch x402scan's directory of indexed x402 resources.
 * Uses x402 payment ($0.01/page) to access their paid API.
 *
 * Run: cd ~/signal402/mcp && npx tsx test/fetch-x402scan.ts
 */

import { x402Fetch } from '../src/client.js';

async function main() {
  console.log('Fetching x402scan directory (page_size=10, $0.01/page)...\n');

  // Start with smaller page to debug, then scale up
  const url = 'https://www.x402scan.com/api/data/resources?page=0&page_size=10';
  console.log(`URL: ${url}`);

  let res: Response;
  try {
    res = await x402Fetch(url, undefined, { maxCostUsd: 0.05 });
  } catch (err: any) {
    console.error('x402Fetch threw:', err.message);
    if (err.cause) console.error('Cause:', err.cause);
    return;
  }

  console.log(`Response: HTTP ${res.status}`);
  console.log('Headers:', Object.fromEntries(res.headers.entries()));

  if (res.status !== 200) {
    console.error(`Failed: HTTP ${res.status}`);
    const body = await res.text();
    console.error(body.slice(0, 1000));
    return;
  }

  const data = await res.json() as any;

  // Show structure
  console.log('Response keys:', Object.keys(data));

  if (data.data && Array.isArray(data.data)) {
    console.log(`\nGot ${data.data.length} resources`);
    if (data.pagination) {
      console.log('Pagination:', JSON.stringify(data.pagination));
    }

    // Extract unique origins
    const origins = new Map<string, any[]>();
    for (const item of data.data) {
      const origin = item.origin || new URL(item.resource).hostname;
      if (!origins.has(origin)) origins.set(origin, []);
      origins.get(origin)!.push(item);
    }

    console.log(`\n${origins.size} unique origins:\n`);

    // Sort by number of endpoints
    const sorted = [...origins.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [origin, items] of sorted) {
      const firstResource = items[0].resource;
      const version = items[0].x402Version || '?';
      console.log(`  ${origin.padEnd(45)} ${items.length} endpoint(s)  v${version}`);
      // Show first endpoint URL
      if (items.length <= 3) {
        for (const item of items) {
          console.log(`    └ ${item.resource}`);
        }
      } else {
        console.log(`    └ ${items[0].resource}`);
        console.log(`    └ ... and ${items.length - 1} more`);
      }
    }
  } else {
    // Unknown format
    console.log(JSON.stringify(data, null, 2).slice(0, 2000));
  }

  // If there are more pages, fetch them too
  if (data.pagination?.has_next_page) {
    console.log('\n--- Fetching page 1 ---\n');
    const res2 = await x402Fetch(
      'https://www.x402scan.com/api/data/resources?page=1&page_size=100',
      undefined,
      { maxCostUsd: 0.05 }
    );
    if (res2.status === 200) {
      const data2 = await res2.json() as any;
      if (data2.data && Array.isArray(data2.data)) {
        console.log(`Page 1: ${data2.data.length} resources`);
        if (data2.pagination) {
          console.log('Pagination:', JSON.stringify(data2.pagination));
        }

        const origins2 = new Map<string, any[]>();
        for (const item of data2.data) {
          const origin = item.origin || new URL(item.resource).hostname;
          if (!origins2.has(origin)) origins2.set(origin, []);
          origins2.get(origin)!.push(item);
        }

        const sorted2 = [...origins2.entries()].sort((a, b) => b[1].length - a[1].length);
        for (const [origin, items] of sorted2) {
          console.log(`  ${origin.padEnd(45)} ${items.length} endpoint(s)`);
        }
      }
    }
  }
}

main().catch(console.error);
