'use client';
import dynamic from 'next/dynamic';
import { useArcNetwork } from '../hooks/useArcNetwork';
// Loaded client-side only — uses wagmi hooks + browser APIs
const AgentChat = dynamic(() => import('./AgentChat'), { ssr: false });
export default function AgentChatWrapper() {
  const { key } = useArcNetwork();
  // Keyed by network: switching Mainnet <-> Testnet starts a fresh conversation,
  // so a wallet button PayBot built on one network can never be clicked on the
  // other (and PayBot's welcome/context always matches the active network).
  return <AgentChat key={key} />;
}
