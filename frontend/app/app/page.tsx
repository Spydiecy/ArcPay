'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import Sidebar, { AppTab } from './components/Sidebar';
import ConnectScreen from './components/ConnectScreen';
import HomePanel from './components/HomePanel';
import dynamic from 'next/dynamic';
import AgentChatWrapper from '../components/AgentChatWrapper';
import NetworkGuard from '../components/NetworkGuard';

const EscrowContent  = dynamic(() => import('../escrow/page').then(m => ({ default: m.default })),  { ssr: false });
const GroupContent   = dynamic(() => import('../group/page').then(m => ({ default: m.default })),   { ssr: false });
const BatchContent   = dynamic(() => import('../batch/page').then(m => ({ default: m.default })),   { ssr: false });
const ProfileContent = dynamic(() => import('../profile/page').then(m => ({ default: m.default })), { ssr: false });
const LinksContent   = dynamic(() => import('../links/page').then(m => ({ default: m.default })),   { ssr: false });
const GatewayFundContent = dynamic(() => import('./components/GatewayFundPanel'), { ssr: false });

export default function AppPage() {
  const { isConnected, isConnecting } = useAccount();
  const [activeTab, setActiveTab] = useState<AppTab>('home');

  if (isConnecting) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--background)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', border: '3px solid var(--primary)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: 'var(--foreground-muted)' }}>Connecting…</p>
        </div>
      </div>
    );
  }

  if (!isConnected) return <ConnectScreen />;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--background)' }}>
      <Sidebar activeTab={activeTab} onTabChange={setActiveTab} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* The Fund tab deliberately moves the wallet to Gateway source chains mid-flow, so don't nag there. */}
        <NetworkGuard hidden={activeTab === 'fund'} />
        <main style={{ flex: 1, overflow: 'auto', background: 'var(--background)' }}>
          {activeTab === 'home'      && <HomePanel onTabChange={setActiveTab} />}
          {activeTab === 'protected' && <EscrowContent />}
          {activeTab === 'group'     && <GroupContent />}
          {activeTab === 'batch'     && <BatchContent />}
          {activeTab === 'links'     && <LinksContent />}
          {activeTab === 'fund'      && <GatewayFundContent onTabChange={setActiveTab} />}
          {activeTab === 'history'   && <ProfileContent />}
        </main>
      </div>
      <AgentChatWrapper />
    </div>
  );
}
