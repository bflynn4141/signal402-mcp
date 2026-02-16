# signal402-mcp

MCP server for x402 ecosystem intelligence. Discover, evaluate, and call any x402 API service with automatic payment.

Works with Claude Code, Claude Desktop, and any MCP-compatible client.

Full docs and service browsing at [signal402.com](https://signal402.com).

## Install

```bash
# Claude Code (one command)
claude mcp add signal402 -- npx signal402-mcp

# Or add to .claude.json / claude_desktop_config.json
{
  "mcpServers": {
    "signal402": {
      "command": "npx",
      "args": ["signal402-mcp"]
    }
  }
}
```

## What You Get

6 tools that give any AI agent access to the x402 paid API ecosystem:

| Tool | Cost | What it does |
|------|------|-------------|
| `signal402_setup` | Free | Create a wallet to pay for x402 services |
| `signal402_catalog` | $0.01 | Browse the full x402 ecosystem |
| `signal402_recommend` | $0.02 | Get ranked service recommendations for a task |
| `signal402_assess` | $0.03 | Deep assessment of a specific x402 project |
| `signal402_probe` | $0.01 | Check if a service is alive and accepting payments |
| `signal402_call` | Varies | Call any x402 service with automatic payment |

## Quick Start

### 1. Set Up a Wallet (free, one-time)

```
signal402_setup email="you@example.com"
```

This creates a wallet on Base and sponsors initial gas. The email makes it recoverable -- you can restore access on any machine.

Without email (faster but not recoverable):

```
signal402_setup
```

### 2. Fund Your Wallet

Send USDC on Base to the address from setup. Three options:

- **From Coinbase:** The setup output includes a direct Coinbase Pay link
- **From any wallet:** Send USDC on Base to your address
- **Bridge from another chain:** Use [jumper.exchange](https://jumper.exchange) to bridge USDC to Base

Minimum recommended: $1.00 (enough for 50 recommend queries or 100 catalog queries).

### 3. Discover Services

```
# "What x402 services can scrape websites?"
signal402_recommend need="web scraping" max_price=0.01

# Browse the full AI category
signal402_catalog category="ai" status="live"

# Is Firecrawl alive right now?
signal402_probe name="firecrawl"
```

### 4. Call a Service

```
# Call a service directly -- payment is automatic
signal402_call url="https://api.firecrawl.dev/v1/scrape" \
  method="POST" \
  body='{"url":"https://example.com"}' \
  max_cost=0.01
```

### 5. Deep Dive

```
# Get an editorial assessment of a service
signal402_assess name="Firecrawl"

# Assess by URL
signal402_assess url="https://firecrawl.dev"
```

## When to Use Each Tool

Use this decision guide to pick the right tool:

| You want to... | Use | Why |
|-----------------|-----|-----|
| Find a service for a task | `signal402_recommend` | Natural language input, returns ranked matches with scores and explanations |
| Browse what exists | `signal402_catalog` | Full ecosystem view with filters (category, status, sort) |
| Evaluate a specific service | `signal402_assess` | Deep dive: verdict, confidence, pricing analysis, alternatives |
| Check if a service is alive | `signal402_probe` | Real-time health check + `.well-known/x402` endpoint discovery |
| Call a paid API | `signal402_call` | Handles the full x402 payment flow -- your wallet pays the service directly |
| Set up or check your wallet | `signal402_setup` | Creates wallet, sponsors gas, shows balance and funding options |

**Typical workflow:**

```
recommend (find it) --> probe (verify it's alive) --> call (use it)
```

Or if you already know the service:

```
probe (check it) --> call (use it)
```

## How Payment Works

- **Discovery tools** (catalog, recommend, assess, probe): Your wallet pays Signal402 via x402. Costs $0.01-$0.03 per query.
- **signal402_call**: Your wallet pays the **target service directly**. Signal402 is not in the payment path. The service sets its own price.
- **Spending guard**: `max_cost` (default $0.10) rejects services that charge more than you expect. Override per-call when needed.

All payments use USDC via the [x402 protocol](https://www.x402.org/). Supports EIP-3009 (TransferWithAuthorization) and Permit2 on any EVM chain (Base, Ethereum, Optimism, Arbitrum, Polygon).

Built on the official [@x402/fetch SDK](https://www.npmjs.com/package/@x402/fetch) for protocol-compliant payment handling (v1 + v2).

## Troubleshooting

### "No wallet configured"

Run `signal402_setup` first. If you previously set up a wallet and it's not found, check that `~/.signal402/wallet.json` exists. Re-running setup with the same email recovers the same wallet.

### "Insufficient USDC balance" or payments failing

Your wallet needs USDC **on Base** (chain ID 8453). Common issues:

- **USDC on the wrong chain:** If you sent USDC on Ethereum mainnet, Arbitrum, or Polygon, it will not work. Bridge to Base using [jumper.exchange](https://jumper.exchange) or send USDC specifically on the Base network.
- **Not enough USDC:** Check your balance with `signal402_setup` (it shows current balance). The minimum useful amount is about $0.10.
- **ETH for gas:** Your wallet needs a small amount of ETH on Base for gas fees. The setup command sponsors initial gas automatically, but if you have been using the wallet heavily, you may need more. Send ~$0.50 of ETH on Base to your wallet address.

### "Service not found" from probe or assess

- Check spelling. Probe uses slug-style matching (e.g., `firecrawl`, not `Firecrawl`).
- The service may not be in the Signal402 catalog. Use `signal402_catalog` to browse what is available, or search by URL: `signal402_assess url="https://theservice.com"`.
- Browse the full directory at [signal402.com/services](https://signal402.com/services).

### "max_cost exceeded" from signal402_call

The default spending cap is $0.10 per request. If the service charges more, increase it:

```
signal402_call url="..." max_cost=0.50
```

This is a safety feature to prevent accidentally paying more than expected.

### x402 payment rejected by a service

- The service may be down or not accepting payments. Run `signal402_probe` to check.
- Some services only support x402 v1 or v2 -- the SDK handles both, but edge cases exist.
- Ensure your wallet has both USDC (for the payment) and ETH (for gas) on Base.

### MCP server not loading

Verify the server is connected:

```bash
claude mcp list
```

If `signal402` does not appear, re-add it:

```bash
claude mcp add signal402 -- npx signal402-mcp
```

If using `claude_desktop_config.json`, restart Claude Desktop after editing the config.

## Requirements

- Node.js >= 18
- A funded wallet (USDC on Base recommended)

## Links

- **Service directory:** [signal402.com](https://signal402.com)
- **Browse services:** [signal402.com/services](https://signal402.com/services)
- **Register a service:** [signal402.com/register](https://signal402.com/register)
- **x402 protocol:** [x402.org](https://www.x402.org/)
- **npm:** [signal402-mcp](https://www.npmjs.com/package/signal402-mcp)
- **GitHub:** [github.com/bflynn4141/signal402](https://github.com/bflynn4141/signal402)
