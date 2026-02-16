import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const WALLET_DIR = join(homedir(), '.signal402');
const WALLET_FILE = join(WALLET_DIR, 'wallet.json');
const CLARA_PROXY = 'https://clara-proxy.bflynn-me.workers.dev';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

interface WalletData {
  address: string;
  walletId: string;
  email: string | null;
  created_at: string;
}

export async function getOrCreateWallet(email?: string): Promise<{ address: string; walletId: string; email: string | null; isNew: boolean; isRecovered: boolean }> {
  // Check for existing wallet
  if (existsSync(WALLET_FILE)) {
    const data: WalletData = JSON.parse(readFileSync(WALLET_FILE, 'utf-8'));
    return { address: data.address, walletId: data.walletId, email: data.email, isNew: false, isRecovered: false };
  }

  // Create new wallet via clara-proxy
  const body: Record<string, string> = { type: 'EVM' };
  if (email) {
    body.userIdentifier = email;
    body.userIdentifierType = 'EMAIL';
  }

  const res = await fetch(`${CLARA_PROXY}/api/v1/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let address: string | undefined;
  let walletId: string | undefined;
  let isRecovered = false;

  if (res.status === 409 && email) {
    isRecovered = true;
    // Wallet already exists for this email — recover via walletId from 409 body
    const conflict = (await res.json()) as { walletId?: string; message?: string };
    if (!conflict.walletId) throw new Error('409 but no walletId in response');
    walletId = conflict.walletId;

    // Look up the wallet address via GET /api/v1/wallets?userIdentifier=...
    const lookupRes = await fetch(
      `${CLARA_PROXY}/api/v1/wallets?userIdentifier=${encodeURIComponent(email)}&userIdentifierType=EMAIL`,
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (!lookupRes.ok) throw new Error(`Wallet lookup failed: ${lookupRes.status}`);
    const lookupData = (await lookupRes.json()) as {
      data?: Array<{ id: string; address: string; type: string }>;
      wallets?: Array<{ id: string; address: string }>;
    };
    // Para returns { data: [...] } — find the EVM wallet matching our walletId
    const wallets = lookupData.data || lookupData.wallets || [];
    const found = wallets.find(w => w.id === walletId);
    address = found?.address;
    if (!address) throw new Error(`Wallet ${walletId} not found in lookup response`);
  } else if (!res.ok) {
    throw new Error(`Wallet creation failed: ${res.status} ${await res.text()}`);
  } else {
    // New wallet created — parse response
    const responseData = (await res.json()) as {
      wallet?: { id: string; address: string };
      wallets?: Array<{ id: string; address: string }>;
      address?: string;
      walletAddress?: string;
      id?: string;
    };

    const walletObj = responseData.wallet || responseData.wallets?.[0];
    address = walletObj?.address || responseData.address || responseData.walletAddress;
    walletId = walletObj?.id || responseData.id;
  }

  if (!address) throw new Error('No address in wallet response');
  if (!walletId) throw new Error('No walletId in wallet response — needed for signing');

  // Save locally with restrictive permissions
  mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  const data: WalletData = { address, walletId, email: email || null, created_at: new Date().toISOString() };
  writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });

  return { address, walletId, email: email || null, isNew: true, isRecovered };
}

export function loadWallet(): WalletData | null {
  if (!existsSync(WALLET_FILE)) return null;
  return JSON.parse(readFileSync(WALLET_FILE, 'utf-8'));
}

export async function sponsorGas(address: string): Promise<boolean> {
  try {
    const res = await fetch(`${CLARA_PROXY}/onboard/sponsor-gas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Clara-Address': address },
      body: JSON.stringify({ address }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkUsdcBalance(address: string): Promise<string> {
  const client = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
  const balance = await client.readContract({
    address: USDC_BASE as `0x${string}`,
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [address as `0x${string}`],
  });
  // USDC has 6 decimals
  const formatted = (Number(balance) / 1e6).toFixed(2);
  return formatted;
}

export function getCoinbasePayUrl(address: string): string {
  const addresses = JSON.stringify({ [address]: ['base'] });
  return `https://pay.coinbase.com/buy/select-asset?addresses=${encodeURIComponent(addresses)}&assets=${encodeURIComponent('["USDC"]')}`;
}
