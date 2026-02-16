import * as p from '@clack/prompts';
import { loadWallet, checkUsdcBalance } from '../wallet.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SESSION_FILE = join(homedir(), '.signal402', 'session.json');

interface SessionData {
  sessionId: string;
  address: string;
  expiresAt: number;
  createdAt: string;
}

/**
 * Read-only status display:
 * - Wallet address + email
 * - USDC balance
 * - Session status + expiry
 */
export async function runStatus() {
  p.intro('signal402 status');

  // ── Wallet ────────────────────────────────────
  const wallet = loadWallet();

  if (!wallet) {
    p.log.warn('No wallet found. Run `signal402 setup` first.');
    p.outro('');
    process.exit(0);
  }

  // ── Balance ───────────────────────────────────
  const s = p.spinner();
  s.start('Checking balance...');
  let balance: string;
  try {
    balance = await checkUsdcBalance(wallet.address);
    s.stop(`Balance: $${balance} USDC`);
  } catch (err) {
    s.stop('Could not check balance');
    balance = '?.??';
  }

  // ── Session ───────────────────────────────────
  let sessionStatus = 'no session';
  if (existsSync(SESSION_FILE)) {
    try {
      const session: SessionData = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));
      const remaining = session.expiresAt - Date.now();
      if (remaining > 0) {
        const hours = Math.round(remaining / 1000 / 60 / 60);
        const mins = Math.round(remaining / 1000 / 60) % 60;
        sessionStatus = `active (expires in ${hours}h ${mins}m)`;
      } else {
        sessionStatus = 'expired — will auto-renew on next query';
      }
    } catch {
      sessionStatus = 'corrupt — will recreate on next query';
    }
  }

  // ── Summary ───────────────────────────────────
  p.note(
    [
      `Wallet:   ${wallet.address}`,
      `Email:    ${wallet.email || 'none'}`,
      `Balance:  $${balance} USDC`,
      `Session:  ${sessionStatus}`,
      `Created:  ${wallet.created_at}`,
    ].join('\n'),
    'Signal402 Status'
  );

  if (parseFloat(balance) === 0) {
    p.log.info('Run `signal402 fund` to add USDC');
  }

  p.outro('');
}
