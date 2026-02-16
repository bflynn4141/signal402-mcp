import * as p from '@clack/prompts';
import open from 'open';
import {
  getOrCreateWallet,
  loadWallet,
  sponsorGas,
  checkUsdcBalance,
  getCoinbasePayUrl,
} from '../wallet.js';
import { getSession } from '../session.js';

/**
 * Interactive setup flow:
 * 1. Check for existing wallet → reuse or create
 * 2. Create wallet (with optional email)
 * 3. Sponsor gas (automatic, silent)
 * 4. Fund with USDC (Coinbase Pay + balance polling)
 * 5. Establish signing session
 * 6. Show summary + MCP registration hint
 */
export async function runSetup() {
  p.intro('signal402 setup');

  // ── Step 1: Check existing wallet ──────────────
  const existing = loadWallet();

  let address: string;
  let walletId: string;
  let email: string | null;
  let isNew = false;

  if (existing) {
    p.log.success(`Wallet found: ${existing.address}`);
    address = existing.address;
    walletId = existing.walletId;
    email = existing.email;
  } else {
    // ── Step 2: Create wallet ──────────────────────
    const method = await p.select({
      message: 'How do you want to set up your wallet?',
      options: [
        {
          value: 'email',
          label: 'With email (recommended)',
          hint: 'portable, recoverable on any device',
        },
        {
          value: 'quick',
          label: 'Quick start (no email)',
          hint: 'fast but not portable',
        },
      ],
    });

    if (p.isCancel(method)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    let userEmail: string | undefined;

    if (method === 'email') {
      const emailInput = await p.text({
        message: 'Enter your email:',
        placeholder: 'you@example.com',
        validate: (v) => {
          if (!v.includes('@')) return 'Please enter a valid email';
        },
      });

      if (p.isCancel(emailInput)) {
        p.cancel('Setup cancelled.');
        process.exit(0);
      }
      userEmail = emailInput;
    }

    const s = p.spinner();
    s.start('Creating wallet...');

    try {
      const wallet = await getOrCreateWallet(userEmail);
      address = wallet.address;
      walletId = wallet.walletId;
      email = wallet.email;
      isNew = wallet.isNew;
      s.stop(wallet.isRecovered ? `Wallet recovered: ${address}` : `Wallet created: ${address}`);
    } catch (err) {
      s.stop('Wallet creation failed');
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  // ── Step 3: Gas sponsorship (automatic) ────────
  if (isNew) {
    const s = p.spinner();
    s.start('Requesting gas sponsorship...');
    const sponsored = await sponsorGas(address);
    s.stop(sponsored ? 'Gas sponsored' : 'Gas sponsorship skipped (may already be sponsored)');
  }

  // ── Step 4: Check USDC balance + funding ───────
  let balance = await checkUsdcBalance(address);
  const funded = parseFloat(balance) > 0;

  if (!funded) {
    const coinbaseUrl = getCoinbasePayUrl(address);

    p.note(
      [
        `Current balance: $${balance}`,
        `Min recommended: $1.00 (100 catalog queries)`,
        '',
        `Fund via:`,
        `  Coinbase Pay: (opening in browser...)`,
        `  Direct send:  Send USDC on Base to ${address}`,
        `  Bridge:       https://jumper.exchange`,
      ].join('\n'),
      'Fund your wallet'
    );

    const fundAction = await p.select({
      message: 'How would you like to fund?',
      options: [
        { value: 'coinbase', label: 'Open Coinbase Pay', hint: 'opens in browser' },
        { value: 'manual', label: 'I\'ll send manually', hint: 'send USDC on Base' },
        { value: 'skip', label: 'Skip for now', hint: 'you can run `signal402 fund` later' },
      ],
    });

    if (p.isCancel(fundAction)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    if (fundAction === 'coinbase') {
      await open(coinbaseUrl);
      p.log.info('Coinbase Pay opened in your browser');
    }

    if (fundAction !== 'skip') {
      // Poll for balance
      balance = await pollBalance(address);
    }
  } else {
    p.log.success(`USDC balance: $${balance}`);
  }

  // ── Step 5: Establish signing session ──────────
  const s = p.spinner();
  s.start('Establishing signing session...');
  try {
    const session = await getSession(walletId, address);
    const expiresIn = Math.round((session.expiresAt - Date.now()) / 1000 / 60 / 60);
    s.stop(`Session active (expires in ${expiresIn}h)`);
  } catch (err) {
    s.stop('Session establishment failed');
    p.log.warn(err instanceof Error ? err.message : String(err));
    p.log.info('You can retry with: signal402 setup');
  }

  // ── Step 6: Summary ────────────────────────────
  balance = await checkUsdcBalance(address);

  p.note(
    [
      `Wallet:  ${address}`,
      `Email:   ${email || 'none'}`,
      `Balance: $${balance} USDC`,
      '',
      `To use Signal402 in Claude Code, add this MCP server:`,
      `  claude mcp add signal402 -- npx signal402-mcp`,
      '',
      `Then use:`,
      `  signal402_catalog  — browse x402 ecosystem ($0.01)`,
      `  signal402_assess   — assess a project ($0.03)`,
    ].join('\n'),
    'Setup complete'
  );

  p.outro('Ready to query the x402 ecosystem!');
}

/**
 * Poll USDC balance every 10s until non-zero or user skips.
 * Uses stdin raw mode to detect Enter keypress for skip.
 */
async function pollBalance(address: string): Promise<string> {
  const s = p.spinner();
  s.start('Waiting for USDC deposit... (press Ctrl+C to skip)');

  const INTERVAL_MS = 10_000;
  const TIMEOUT_MS = 300_000; // 5 minutes
  const start = Date.now();

  return new Promise<string>((resolve) => {
    const check = async () => {
      try {
        const balance = await checkUsdcBalance(address);
        const elapsed = Math.round((Date.now() - start) / 1000);

        if (parseFloat(balance) > 0) {
          s.stop(`USDC received: $${balance}`);
          resolve(balance);
          return;
        }

        if (Date.now() - start > TIMEOUT_MS) {
          s.stop('Timed out waiting for deposit');
          p.log.info('Run `signal402 fund` when you\'re ready to fund');
          resolve(balance);
          return;
        }

        s.message(`Waiting for USDC deposit... $${balance} (${elapsed}s elapsed)`);
        setTimeout(check, INTERVAL_MS);
      } catch {
        // Network error during poll — keep going
        setTimeout(check, INTERVAL_MS);
      }
    };

    // Start first check after a brief delay
    setTimeout(check, INTERVAL_MS);
  });
}
