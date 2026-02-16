import * as p from '@clack/prompts';
import open from 'open';
import { loadWallet, checkUsdcBalance, getCoinbasePayUrl } from '../wallet.js';

/**
 * Funding-only flow: show current balance, present funding options,
 * and poll for incoming deposit. Subset of the full setup flow.
 */
export async function runFund() {
  p.intro('signal402 fund');

  // ── Load wallet ───────────────────────────────
  const wallet = loadWallet();

  if (!wallet) {
    p.log.warn('No wallet found. Run `signal402 setup` first.');
    p.outro('');
    process.exit(0);
  }

  // ── Check current balance ─────────────────────
  const s = p.spinner();
  s.start('Checking balance...');
  let balance: string;
  try {
    balance = await checkUsdcBalance(wallet.address);
    s.stop(`Current balance: $${balance} USDC`);
  } catch (err) {
    s.stop('Could not check balance');
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (parseFloat(balance) > 0) {
    p.log.success(`Wallet is already funded with $${balance} USDC`);

    const cont = await p.confirm({
      message: 'Add more USDC?',
      initialValue: false,
    });

    if (p.isCancel(cont) || !cont) {
      p.outro('');
      return;
    }
  }

  // ── Show funding options ──────────────────────
  const coinbaseUrl = getCoinbasePayUrl(wallet.address);

  p.note(
    [
      `Send USDC on Base to:`,
      `  ${wallet.address}`,
      '',
      `Min recommended: $1.00 (100 catalog queries)`,
    ].join('\n'),
    'Funding'
  );

  const action = await p.select({
    message: 'How would you like to fund?',
    options: [
      { value: 'coinbase', label: 'Open Coinbase Pay', hint: 'opens in browser' },
      { value: 'manual', label: 'I\'ll send manually', hint: 'send USDC on Base' },
      { value: 'skip', label: 'Cancel', hint: 'fund later' },
    ],
  });

  if (p.isCancel(action) || action === 'skip') {
    p.outro('Run `signal402 fund` when you\'re ready');
    return;
  }

  if (action === 'coinbase') {
    await open(coinbaseUrl);
    p.log.info('Coinbase Pay opened in your browser');
  }

  // ── Poll for deposit ──────────────────────────
  const finalBalance = await pollBalance(wallet.address);

  if (parseFloat(finalBalance) > 0) {
    p.outro(`Wallet funded: $${finalBalance} USDC`);
  } else {
    p.outro('Run `signal402 fund` when you\'re ready');
  }
}

/**
 * Poll USDC balance every 10s until non-zero or timeout.
 */
async function pollBalance(address: string): Promise<string> {
  const s = p.spinner();
  s.start('Waiting for USDC deposit...');

  const INTERVAL_MS = 10_000;
  const TIMEOUT_MS = 300_000;
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
          resolve(balance);
          return;
        }

        s.message(`Waiting for USDC deposit... $${balance} (${elapsed}s elapsed)`);
        setTimeout(check, INTERVAL_MS);
      } catch {
        setTimeout(check, INTERVAL_MS);
      }
    };

    setTimeout(check, INTERVAL_MS);
  });
}
