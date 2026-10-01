'use client';

import { useState, useCallback, useRef } from 'react';
import { useAccount, useChainId, useSwitchChain, useSignTypedData, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { waitForTransactionReceipt } from '@wagmi/core';
import {
  GATEWAY_WALLET_ADDRESS,
  GATEWAY_MINTER_ADDRESS,
  GATEWAY_MINTER_ABI,
  ARC_TESTNET_DOMAIN,
  ARC_TESTNET_USDC,
  GATEWAY_EIP712_DOMAIN,
  EIP712Domain,
  TransferSpecType,
  BurnIntentType,
  addressToBytes32,
  estimateMaxFee,
  formatGatewayError,
} from '../lib/gateway';
import { arcTestnet, wagmiConfig } from '../lib/wagmi';

// ── Types ─────────────────────────────────────────────────────────────────────
export type GatewayTransferPhase =
  | 'idle' | 'signing' | 'signed' | 'submitting' | 'attested' | 'minting' | 'done' | 'error';

export interface SignBurnIntentParams {
  sourceDomain: number;
  sourceUsdcAddress: `0x${string}`;
  amountMicroUsdc: bigint;
  sourceGasFeeUsd: number;
  /** Available unified balance (micro-USDC) on the selected source chain, used
   *  for the pre-signature check in Requirement 2.4. Passed in rather than
   *  fetched internally so this hook stays decoupled from useGatewayBalance. */
  availableMicroUsdc: bigint;
}

interface BurnIntentMessage {
  maxBlockHeight: string;
  maxFee: string;
  spec: {
    version: 1;
    sourceDomain: number;
    destinationDomain: number;
    sourceContract: `0x${string}`;
    destinationContract: `0x${string}`;
    sourceToken: `0x${string}`;
    destinationToken: `0x${string}`;
    sourceDepositor: `0x${string}`;
    destinationRecipient: `0x${string}`;
    sourceSigner: `0x${string}`;
    destinationCaller: `0x${string}`;
    value: string;
    salt: `0x${string}`;
    hookData: '0x';
  };
}

interface GatewayAttestation {
  attestation: string;
  signature: string;
  transferId?: string;
  expirationBlock?: string;
  issuedAt: number; // client-tracked ms timestamp, for the 10-minute expiry check
}

// Attestations expire after 10 minutes per Circle's documented behavior
// (Requirement 3.5 / Property 5). Checked client-side as a UX guard; the
// contract's own maxBlockHeight check is the real backstop.
const ATTESTATION_TTL_MS = 10 * 60 * 1000;

function randomSalt(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ('0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

export function useGatewayTransfer() {
  const { address } = useAccount();
  const currentChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<GatewayTransferPhase>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [mintTxHash, setMintTxHash] = useState<`0x${string}` | undefined>();
  // Tracks which step an error occurred in, independent of `errorMsg`'s
  // wording — used to decide whether "Retry Mint" is offered, rather than
  // string-matching the (now human-friendly, reworded) error message.
  const [failedStep, setFailedStep] = useState<'sign' | 'attest' | 'mint' | null>(null);
  const attestationRef = useRef<GatewayAttestation | null>(null);

  const { isSuccess: mintConfirmed } = useWaitForTransactionReceipt({ hash: mintTxHash });

  // Only meaningful for the held (ref-tracked) attestation from
  // requestAttestation(). When a caller passes an explicit attestation/
  // signature directly to mint(), there is no held record to check — the
  // contract's own maxBlockHeight check is the backstop in that case.
  const isHeldAttestationExpired = useCallback(() => {
    const held = attestationRef.current;
    if (!held) return false;
    return Date.now() - held.issuedAt > ATTESTATION_TTL_MS;
  }, []);

  // ── Requirement 2: construct + sign the burn intent ───────────────────────
  const signBurnIntent = useCallback(async (params: SignBurnIntentParams) => {
    if (!address) throw new Error('Wallet not connected');

    // Requirement 2.4: block signing if the requested amount exceeds the
    // available balance on the selected source chain — never request a
    // signature for an intent that Circle will reject.
    if (params.amountMicroUsdc > params.availableMicroUsdc) {
      setPhase('error');
      setErrorMsg('Requested amount exceeds your available balance on this chain.');
      throw new Error('Insufficient Gateway balance for requested amount');
    }

    setErrorMsg('');
    setFailedStep(null);
    setPhase('signing');

    const maxFee = estimateMaxFee(params.amountMicroUsdc, params.sourceGasFeeUsd);

    const message: BurnIntentMessage = {
      maxBlockHeight: (2n ** 256n - 1n).toString(),
      maxFee: maxFee.toString(),
      spec: {
        version: 1,
        sourceDomain: params.sourceDomain,
        // Property 2: destinationDomain is always Arc Testnet — hardcoded,
        // never threaded from user input.
        destinationDomain: ARC_TESTNET_DOMAIN,
        sourceContract: addressToBytes32(GATEWAY_WALLET_ADDRESS),
        destinationContract: addressToBytes32(GATEWAY_MINTER_ADDRESS),
        sourceToken: addressToBytes32(params.sourceUsdcAddress),
        destinationToken: addressToBytes32(ARC_TESTNET_USDC),
        sourceDepositor: addressToBytes32(address),
        destinationRecipient: addressToBytes32(address), // mint to the user's own Arc wallet
        sourceSigner: addressToBytes32(address),
        destinationCaller: addressToBytes32('0x0000000000000000000000000000000000000000'),
        value: params.amountMicroUsdc.toString(),
        // Property 1: a fresh salt every call — never reused.
        salt: randomSalt(),
        // Confirmed unused by the deployed GatewayMinter (see design doc spike) — always empty.
        hookData: '0x',
      },
    };

    try {
      const signature = await signTypedDataAsync({
        domain: GATEWAY_EIP712_DOMAIN,
        types: { EIP712Domain, TransferSpec: TransferSpecType, BurnIntent: BurnIntentType },
        primaryType: 'BurnIntent',
        message: message as never,
      });
      setPhase('signed');
      return { burnIntent: message, signature };
    } catch (e) {
      setPhase('error');
      setFailedStep('sign');
      setErrorMsg(formatGatewayError(e));
      throw e;
    }
  }, [address, signTypedDataAsync]);

  // ── Requirement 3: submit the signed intent for an attestation ────────────
  const requestAttestation = useCallback(async (
    burnIntent: BurnIntentMessage,
    signature: string,
  ) => {
    setPhase('submitting');
    try {
      const res = await fetch('/api/gateway/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ burnIntent, signature }], (_k, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      });
      const json = await res.json();
      if (!res.ok) {
        // Requirement 3.3: surface Circle's exact error, never auto-retry
        // with a mutated intent.
        throw new Error(json?.error ?? json?.message ?? `Gateway transfer request failed (${res.status})`);
      }
      if (!json.attestation || !json.signature) {
        throw new Error('Gateway API returned no attestation');
      }
      attestationRef.current = {
        attestation: json.attestation,
        signature: json.signature,
        transferId: json.transferId,
        expirationBlock: json.expirationBlock,
        issuedAt: Date.now(),
      };
      setPhase('attested');
      return attestationRef.current;
    } catch (e) {
      setPhase('error');
      setFailedStep('attest');
      setErrorMsg(formatGatewayError(e));
      throw e;
    }
  }, []);

  // ── Requirement 4.1 / Property 5: mint on Arc, independently retryable ────
  // Decoupled from signing/attestation so a failed or rejected mint can be
  // retried without re-signing or re-hitting the Gateway API, as long as the
  // held attestation hasn't expired.
  const mint = useCallback(async (attestation?: string, signature?: string) => {
    const held = attestationRef.current;
    const usingHeld = attestation === undefined && signature === undefined;
    const attestationPayload = attestation ?? held?.attestation;
    const attestationSig = signature ?? held?.signature;

    if (!attestationPayload || !attestationSig) {
      throw new Error('No attestation available — sign and submit a burn intent first');
    }
    // Only check client-side expiry when relying on the held (ref-tracked)
    // attestation from requestAttestation() — an explicitly-passed
    // attestation/signature pair is the caller's responsibility, backstopped
    // by the contract's own maxBlockHeight check.
    if (usingHeld && isHeldAttestationExpired()) {
      setPhase('error');
      setErrorMsg('Attestation expired — please sign a new transfer.');
      throw new Error('Attestation expired');
    }

    setPhase('minting');
    try {
      // The mint always happens on Arc Testnet — ensure the wallet is
      // actually there before submitting, since the user may still be on a
      // Gateway source chain right after depositing.
      if (currentChainId !== arcTestnet.id) {
        await switchChainAsync({ chainId: arcTestnet.id });
      }

      const hash = await writeContractAsync({
        address: GATEWAY_MINTER_ADDRESS,
        abi: GATEWAY_MINTER_ABI,
        functionName: 'gatewayMint',
        args: [attestationPayload as `0x${string}`, attestationSig as `0x${string}`],
        chainId: arcTestnet.id,
      });
      setMintTxHash(hash);
      // Wait for the mint to actually be mined before reporting "done" — a
      // caller-triggered balance refresh that fires the instant the tx is
      // *submitted* (rather than confirmed) reads stale pre-mint balances,
      // which is exactly what produced the "balance didn't update" reports.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await waitForTransactionReceipt(wagmiConfig as any, { hash, chainId: arcTestnet.id });
      setPhase('done');
      return hash;
    } catch (e) {
      // Property 5/6: preserve the held attestation on a failed mint so the
      // caller can offer "retry mint" without re-signing.
      setPhase('error');
      setFailedStep('mint');
      setErrorMsg(formatGatewayError(e));
      throw e;
    }
  }, [writeContractAsync, isHeldAttestationExpired, currentChainId, switchChainAsync]);

  const reset = useCallback(() => {
    attestationRef.current = null;
    setMintTxHash(undefined);
    setErrorMsg('');
    setFailedStep(null);
    setPhase('idle');
  }, []);

  return {
    phase,
    errorMsg,
    failedStep,
    mintTxHash,
    mintConfirmed,
    signBurnIntent,
    requestAttestation,
    mint,
    reset,
    hasAttestation: () => !!attestationRef.current && !isHeldAttestationExpired(),
  };
}
