import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getOrCreateWallet, sponsorGas, checkUsdcBalance, getCoinbasePayUrl, loadWallet } from './wallet.js';
import { fetchCatalog, fetchAssess, fetchRecommend, fetchProbe, x402Fetch } from './client.js';

const server = new McpServer({
  name: 'signal402',
  version: '0.1.0',
});

// Tool 1: signal402_setup (free, local)
server.tool(
  'signal402_setup',
  'Set up a wallet to use x402 services. Creates a Para wallet, sponsors gas, and shows how to fund with USDC.',
  { email: z.string().email().optional().describe('Email for wallet recovery (recommended)') },
  async ({ email }) => {
    const wallet = await getOrCreateWallet(email);
    let gasSponsored = false;
    if (wallet.isNew) {
      gasSponsored = await sponsorGas(wallet.address);
    }
    const balance = await checkUsdcBalance(wallet.address);
    const funded = parseFloat(balance) > 0;
    const coinbaseUrl = getCoinbasePayUrl(wallet.address);
    const basescanUrl = `https://basescan.org/address/${wallet.address}`;

    const lines = [
      wallet.isNew ? (wallet.isRecovered ? 'Wallet recovered! (email already registered)' : 'Wallet created!') : 'Wallet loaded from ~/.signal402/wallet.json',
      '',
      `Address: ${wallet.address}`,
      `Email: ${wallet.email || 'none (not recoverable)'}`,
      `Gas sponsored: ${gasSponsored ? 'yes' : wallet.isNew ? 'failed (may already be sponsored)' : 'previously done'}`,
      `USDC balance: $${balance}`,
      '',
    ];

    if (!funded) {
      lines.push(
        'Fund your wallet with USDC on Base:',
        '',
        'Option 1: Send from Coinbase',
        `  ${coinbaseUrl}`,
        '',
        'Option 2: Send from any wallet',
        `  Send USDC on Base to ${wallet.address}`,
        '',
        'Option 3: Bridge from another chain',
        '  Use https://jumper.exchange to bridge to Base',
        '',
        `Track: ${basescanUrl}`,
        '',
        'Min recommended: $1.00 (100 catalog queries at $0.01 each)',
      );
    } else {
      lines.push('Wallet is funded and ready to use Signal402!');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  }
);

// Tool 2: signal402_catalog (paid $0.01)
server.tool(
  'signal402_catalog',
  'Browse the x402 ecosystem: facilitators, services, and whitespace opportunities. Costs $0.01 via x402.',
  {
    category: z.enum(['ai', 'data', 'media', 'tools', 'infrastructure']).optional().describe('Filter by category'),
    status: z.enum(['live', 'beta', 'announced', 'dead']).optional().describe('Filter by status'),
    sort: z.enum(['market_share', 'name']).optional().describe('Sort order'),
  },
  async ({ category, status, sort }) => {
    const result = await fetchCatalog({ category, status, sort });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool 3: signal402_assess (paid $0.03)
server.tool(
  'signal402_assess',
  'Assess a specific x402 project. Is it real? Get verdict, recommendation, and alternatives. Costs $0.03 via x402.',
  {
    url: z.string().url().optional().describe('Project URL to assess'),
    name: z.string().optional().describe('Project name to look up'),
  },
  async ({ url, name }) => {
    if (!url && !name) {
      return { content: [{ type: 'text', text: 'Please provide either a url or name to assess.' }] };
    }
    const result = await fetchAssess({ url, name });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool 4: signal402_recommend (paid $0.02)
server.tool(
  'signal402_recommend',
  'Get ranked x402 service recommendations for a task. Describe what you need and get scored matches with explanations. Costs $0.02 via x402.',
  {
    need: z.string().describe('What you need — e.g. "web scraping", "AI inference", "data enrichment"'),
    category: z.enum(['ai', 'data', 'media', 'tools', 'infrastructure']).optional().describe('Filter to a specific category'),
    max_price: z.number().optional().describe('Maximum price per request in USD (e.g. 0.01)'),
    status: z.enum(['live', 'beta']).optional().describe('Filter by service status'),
    limit: z.number().min(1).max(10).optional().describe('Max results to return (1-10, default 5)'),
  },
  async ({ need, category, max_price, status, limit }) => {
    const result = await fetchRecommend({ need, category, max_price, status, limit });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool 5: signal402_probe (paid $0.01)
server.tool(
  'signal402_probe',
  'Check if an x402 service is alive and accepting payments right now. Returns health status, response time, live pricing, and catalog price comparison. Cached 5 min. Costs $0.01 via x402.',
  {
    name: z.string().optional().describe('Service name to probe (e.g. "firecrawl", "zyte")'),
    url: z.string().url().optional().describe('Service URL to probe'),
  },
  async ({ name, url }) => {
    if (!name && !url) {
      return { content: [{ type: 'text', text: 'Provide either a name or url to probe.' }] };
    }
    const result = await fetchProbe({ name, url });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool 6: signal402_call (pays target service directly)
server.tool(
  'signal402_call',
  'Call any x402 service and pay automatically. Your wallet pays the service directly — Signal402 is not in the payment path. Use signal402_recommend first to find the right service, then call it here.',
  {
    url: z.string().url().describe('The x402 API endpoint URL to call'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET').describe('HTTP method'),
    body: z.string().optional().describe('Request body (JSON string) for POST/PUT requests'),
    headers: z.record(z.string()).optional().describe('Additional headers to send'),
    max_cost: z.number().positive().default(0.10).describe('Maximum USD willing to pay per request (safety cap, default $0.10)'),
  },
  async ({ url, method, body, headers, max_cost }) => {
    const wallet = loadWallet();
    if (!wallet) {
      return {
        content: [{ type: 'text', text: 'No wallet configured. Run signal402_setup first.' }],
        isError: true,
      };
    }

    try {
      const reqInit: RequestInit = { method };
      if (body) reqInit.body = body;
      if (headers) reqInit.headers = { ...headers };

      // Ensure Content-Type for POST/PUT with body
      if (body && !headers?.['Content-Type'] && !headers?.['content-type']) {
        reqInit.headers = { ...(reqInit.headers as Record<string, string>), 'Content-Type': 'application/json' };
      }

      const res = await x402Fetch(url, reqInit, { maxCostUsd: max_cost });
      const contentType = res.headers.get('content-type') || '';
      let responseText: string;

      if (contentType.includes('application/json')) {
        const json = await res.json();
        responseText = JSON.stringify(json, null, 2);
      } else {
        responseText = await res.text();
        // Truncate very large responses
        if (responseText.length > 50_000) {
          responseText = responseText.slice(0, 50_000) + '\n\n[...truncated at 50KB]';
        }
      }

      return {
        content: [{
          type: 'text',
          text: `HTTP ${res.status} ${res.statusText}\n\n${responseText}`,
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
