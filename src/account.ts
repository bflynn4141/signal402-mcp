/**
 * Para Wallet → x402 Signer Adapter
 *
 * Bridges Para's remote key custody (via clara-proxy) with the @x402 SDK's
 * ClientEvmSigner interface. The SDK calls signTypedData() with EIP-712
 * typed data; we hash client-side and send the hash to clara-proxy's
 * sign-raw endpoint for signing by the Para-managed key.
 *
 * This is the same pattern as clara-mcp's account.ts: hashTypedData → signRawHash
 */

import { hashTypedData, type Hex } from 'viem';
import type { ClientEvmSigner } from '@x402/evm';
import { getSession, signRequest } from './session.js';

const CLARA_PROXY = 'https://clara-proxy.bflynn-me.workers.dev';

/**
 * Create a ClientEvmSigner that signs via clara-proxy's sign-raw endpoint.
 *
 * The @x402 SDK calls signTypedData() with the full EIP-712 domain/types/message.
 * We hash it locally (no key material leaves the server), then POST the 32-byte
 * hash to Para's sign-raw, which returns the signature.
 */
export function createParaSigner(walletId: string, address: string): ClientEvmSigner {
  return {
    address: address as `0x${string}`,

    async signTypedData(typedData: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> {
      // Hash the EIP-712 typed data client-side
      const hash = hashTypedData({
        domain: typedData.domain as any,
        types: typedData.types as any,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });

      // Get session for authenticated signing
      const session = await getSession(walletId, address);
      const signPath = `/api/v1/wallets/${walletId}/sign-raw`;
      const signBody = JSON.stringify({ data: hash });
      const authHeaders = await signRequest(session, 'POST', signPath, signBody);

      // Sign via clara-proxy
      const signRes = await fetch(`${CLARA_PROXY}${signPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: signBody,
      });

      if (!signRes.ok) {
        const errText = await signRes.text();
        throw new Error(`sign-raw failed: ${signRes.status} — ${errText}`);
      }

      const signData = (await signRes.json()) as { signature?: string; result?: string };
      const sig = signData.signature || signData.result;
      if (!sig) throw new Error('No signature in sign-raw response');

      // Normalize: ensure 0x prefix
      return (sig.startsWith('0x') ? sig : `0x${sig}`) as `0x${string}`;
    },
  };
}
