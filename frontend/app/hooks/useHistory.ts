'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAccount, useBalance, usePublicClient } from 'wagmi';
import { PROTECTED_PAY_ABI, ESCROW_STATUS_LABEL, GROUP_STATUS_LABEL } from '../lib/abi';
import { getContractAddress, formatNative, arcTestnet } from '../lib/wagmi';

// ── Types ─────────────────────────────────────────────────────────────────────
export interface EscrowRecord {
  id: string;
  sender: string;
  recipient: string;
  amount: string;      // raw wei as string
  status: string;      // 'Pending' | 'Claimed' | 'Refunded'
  remarks: string;
  createdAt: string;
}

export interface GroupRecord {
  id: string;
  creator: string;
  recipient: string;
  totalAmount: string;
  amountPerPerson: string;
  numParticipants: string;
  contributedCount: string;
  amountCollected: string;
  remarks: string;
  status: string;      // 'Open' | 'Completed' | 'Cancelled'
  createdAt: string;
}

export interface BatchRecord {
  id: string;
  creator: string;
  totalAmount: string;
  recipientCount: string;
  remarks: string;
  createdAt: string;
}

export interface TokenEscrowRecord {
  id: string;
  token: string;
  sender: string;
  recipient: string;
  amount: string;
  status: string;
  remarks: string;
  createdAt: string;
}

export interface PaymentLinkRecord {
  linkId: string;      // hex bytes32
  creator: string;
  amount: string;      // wei string, '0' = any amount
  description: string;
  status: string;      // 'Active' | 'Paid' | 'Cancelled'
  createdAt: string;
  paidAt: string;
  paidBy: string;
  remarks: string;     // payer note
}

export const LINK_STATUS_LABEL: Record<number, string> = {
  0: 'Active',
  1: 'Paid',
  2: 'Cancelled',
};

// ── Format helpers ─────────────────────────────────────────────────────────────
export function formatPOT(raw: string): string {
  const symbol = process.env.NEXT_PUBLIC_NATIVE_SYMBOL || 'USDC';
  if (!raw || raw === '0') return `0 ${symbol}`;
  try {
    const wei = BigInt(raw.replace(/,/g, ''));
    const formatted = formatNative(wei);
    return `${formatted} ${symbol}`;
  } catch {
    return `— ${symbol}`;
  }
}

export function shortAddr(a: string): string {
  if (!a || a.length < 10) return a;
  return `${a.slice(0, 8)}…${a.slice(-6)}`;
}

// ── Map raw tuple from contract → typed record ────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapEscrow(e: any): EscrowRecord {
  return {
    id:        String(e.id),
    sender:    e.sender,
    recipient: e.recipient,
    amount:    String(e.amount),
    status:    ESCROW_STATUS_LABEL[Number(e.status)] ?? 'Unknown',
    remarks:   e.remarks,
    createdAt: String(e.createdAt),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapGroup(g: any): GroupRecord {
  return {
    id:               String(g.id),
    creator:          g.creator,
    recipient:        g.recipient,
    totalAmount:      String(g.totalAmount),
    amountPerPerson:  String(g.amountPerPerson),
    numParticipants:  String(g.numParticipants),
    contributedCount: String(g.contributedCount),
    amountCollected:  String(g.amountCollected),
    remarks:          g.remarks,
    status:           GROUP_STATUS_LABEL[Number(g.status)] ?? 'Unknown',
    createdAt:        String(g.createdAt),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapBatch(b: any): BatchRecord {
  return {
    id:             String(b.id),
    creator:        b.creator,
    totalAmount:    String(b.totalAmount),
    recipientCount: String(b.recipientCount),
    remarks:        b.remarks,
    createdAt:      String(b.createdAt),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapTokenEscrow(e: any): TokenEscrowRecord {
  return {
    id:        String(e.id),
    token:     e.token,
    sender:    e.sender,
    recipient: e.recipient,
    amount:    String(e.amount),
    status:    ESCROW_STATUS_LABEL[Number(e.status)] ?? 'Unknown',
    remarks:   e.remarks,
    createdAt: String(e.createdAt),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapPaymentLink(l: any): PaymentLinkRecord {
  return {
    linkId:      l.linkId,
    creator:     l.creator,
    amount:      String(l.amount),
    description: l.description,
    status:      LINK_STATUS_LABEL[Number(l.status)] ?? 'Unknown',
    createdAt:   String(l.createdAt),
    paidAt:      String(l.paidAt),
    paidBy:      l.paidBy,
    remarks:     l.remarks,
  };
}

export function useHistory() {
  const { address } = useAccount();
  // Pinned to Arc Testnet explicitly — ArcPay's contract history/balance must
  // always reflect Arc, never whatever chain the wallet happens to be
  // connected to (e.g. mid-deposit on a Gateway source chain).
  const chainId     = arcTestnet.id;
  const client      = usePublicClient({ chainId: arcTestnet.id });
  const { data: balanceData, refetch: refetchBalance } = useBalance({ address, chainId: arcTestnet.id });

  const [escrows,       setEscrows]       = useState<EscrowRecord[]>([]);
  const [tokenEscrows,  setTokenEscrows]  = useState<TokenEscrowRecord[]>([]);
  const [groups,        setGroups]        = useState<GroupRecord[]>([]);
  const [batches,       setBatches]       = useState<BatchRecord[]>([]);
  const [paymentLinks,  setPaymentLinks]  = useState<PaymentLinkRecord[]>([]);
  const [balance,       setBalance]       = useState<string | null>(null);
  const [loading,       setLoading]       = useState(false);

  const refresh = useCallback(async () => {
    if (!address || !client) return;
    const contractAddress = getContractAddress(chainId);
    setLoading(true);

    // Each read is independent — the public Arc Testnet RPC can be flaky or
    // rate-limit concurrent requests, and a single failed call must not wipe
    // out data that loaded fine (e.g. balance disappearing because a
    // getUserGroups call happened to fail). Promise.allSettled + per-result
    // handling means a transient failure just leaves that slice unchanged.
    const [bal, rawEscrows, rawTokenEscrows, rawGroups, rawBatches, rawLinks] = await Promise.allSettled([
      refetchBalance(),
      client.readContract({ address: contractAddress, abi: PROTECTED_PAY_ABI, functionName: 'getUserEscrows', args: [address] }),
      client.readContract({ address: contractAddress, abi: PROTECTED_PAY_ABI, functionName: 'getUserTokenEscrows', args: [address] }),
      client.readContract({ address: contractAddress, abi: PROTECTED_PAY_ABI, functionName: 'getUserGroups', args: [address] }),
      client.readContract({ address: contractAddress, abi: PROTECTED_PAY_ABI, functionName: 'getUserBatches', args: [address] }),
      client.readContract({ address: contractAddress, abi: PROTECTED_PAY_ABI, functionName: 'getUserPaymentLinks', args: [address] }),
    ]);

    if (bal.status === 'fulfilled' && bal.value.data) setBalance(String(bal.value.data.value));
    else if (bal.status === 'rejected') console.warn('Balance refresh failed:', bal.reason);

    if (rawEscrows.status === 'fulfilled') setEscrows([...(rawEscrows.value as unknown[])].reverse().map(mapEscrow));
    else console.warn('Escrow history refresh failed:', rawEscrows.reason);

    if (rawTokenEscrows.status === 'fulfilled') setTokenEscrows([...(rawTokenEscrows.value as unknown[])].reverse().map(mapTokenEscrow));
    else console.warn('Token escrow history refresh failed:', rawTokenEscrows.reason);

    if (rawGroups.status === 'fulfilled') setGroups([...(rawGroups.value as unknown[])].reverse().map(mapGroup));
    else console.warn('Group history refresh failed:', rawGroups.reason);

    if (rawBatches.status === 'fulfilled') setBatches([...(rawBatches.value as unknown[])].reverse().map(mapBatch));
    else console.warn('Batch history refresh failed:', rawBatches.reason);

    if (rawLinks.status === 'fulfilled') setPaymentLinks([...(rawLinks.value as unknown[])].reverse().map(mapPaymentLink));
    else console.warn('Payment link history refresh failed:', rawLinks.reason);

    setLoading(false);
  }, [address, chainId, client, refetchBalance]);

  // ── Auto-refresh when chain or address changes ────────────────────────────
  const prevAddrRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Only clear stale data when the address actually changes (switching
    // accounts) — not on every re-render/reconnect, so a transient RPC
    // hiccup on refresh doesn't blank the UI before the retry lands.
    if (prevAddrRef.current !== address) {
      setEscrows([]);
      setTokenEscrows([]);
      setGroups([]);
      setBatches([]);
      setPaymentLinks([]);
      setBalance(null);
      prevAddrRef.current = address;
    }
    if (address && client) refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, address, client]);

  const formattedBalance = balance ? formatPOT(balance)
    : balanceData ? `${formatNative(balanceData.value)} ${balanceData.symbol}`
    : null;

  return { escrows, tokenEscrows, groups, batches, paymentLinks, balance, formattedBalance, loading, refresh };
}
