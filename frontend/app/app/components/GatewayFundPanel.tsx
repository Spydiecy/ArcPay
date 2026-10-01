'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useGatewayBalance } from '../../hooks/useGatewayBalance';
import { useGatewayTransfer } from '../../hooks/useGatewayTransfer';
import { useGatewayDeposit } from '../../hooks/useGatewayDeposit';
import { useGatewayHistory } from '../../hooks/useGatewayHistory';
import { useHistory } from '../../hooks/useHistory';
import { GATEWAY_SOURCE_CHAINS, GATEWAY_WARN_THRESHOLD_USDC, decimalUsdcToMicro } from '../../lib/gateway';
import { UsdcBadge } from '../../components/UsdcIcon';
import Toast, { ToastType } from '../../components/Toast';
import { AppTab } from './Sidebar';
import {
  Globe, RefreshCw, ArrowRight, CheckCircle2, AlertTriangle,
  Loader2, ShieldCheck, XCircle, ArrowDownToLine, Send,
} from 'lucide-react';

const INPUT: React.CSSProperties = {
  width: '100%', padding: '12px 16px', borderRadius: 10,
  background: 'var(--surface-elevated)', color: 'var(--foreground)',
  border: '1px solid var(--border)', fontSize: 14, outline: 'none', boxSizing: 'border-box',
};

interface GatewayFundPanelProps {
  onTabChange: (tab: AppTab) => void;
}

const PHASE_LABEL: Record<string, string> = {
  idle: '',
  signing: 'Waiting for signature…',
  signed: 'Signed — requesting attestation…',
  submitting: 'Requesting attestation from Circle…',
  attested: 'Attestation received — ready to mint',
  minting: 'Confirming mint on Arc Testnet…',
  done: 'USDC minted on Arc Testnet',
  error: 'Something went wrong',
};

const DEPOSIT_PHASE_LABEL: Record<string, string> = {
  idle: '',
  switching: 'Switching network…',
  checking: 'Checking token allowance…',
  approving: 'Approving USDC spend…',
  depositing: 'Depositing into Gateway…',
  restoring: 'Switching back to Arc Testnet…',
  done: 'Deposited — waiting for finality',
  error: 'Something went wrong',
};

type PanelMode = 'deposit' | 'transfer';

export default function GatewayFundPanel({ onTabChange }: GatewayFundPanelProps) {
  const { balances, pendingDeposits, total, loading: balanceLoading, error: balanceError, refresh: refreshBalance } = useGatewayBalance();
  const {
    phase, errorMsg, failedStep, mintTxHash, mintConfirmed,
    signBurnIntent, requestAttestation, mint,
  } = useGatewayTransfer();
  // Reuse ArcPay's existing Arc-native balance/history refresh — the mint
  // lands as native-spendable USDC on Arc (see design doc's decimals
  // resolution), so this is the same refresh already used by HomePanel/
  // Sidebar, not a new parallel balance source.
  const { formattedBalance: arcNativeBalance, refresh: refreshArcHistory } = useHistory();
  const {
    phase: depositPhase, errorMsg: depositErrorMsg,
    approveTxHash, depositTxHash, deposit, reset: resetDeposit,
  } = useGatewayDeposit();
  const { entries: historyEntries, addEntry: addHistoryEntry } = useGatewayHistory();

  const [mode, setMode] = useState<PanelMode>('deposit');
  const [sourceKey, setSourceKey] = useState(GATEWAY_SOURCE_CHAINS[0]?.key ?? '');
  const [amount, setAmount] = useState('');
  const [toast, setToast] = useState<{ msg: string; type: ToastType } | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  // Tracks whether the user has explicitly picked a source chain — once they
  // have, auto-selection below must never override their choice.
  const userPickedSourceRef = useRef(false);

  // The dropdown used to always default to the first entry in
  // GATEWAY_SOURCE_CHAINS (Ethereum Sepolia) regardless of where the user's
  // unified balance actually was — so a user funded on Base Sepolia would
  // land on a "0.0000 USDC available" chain and get a confusing "amount
  // exceeds available balance" error for an amount that was well within
  // their real total. Once balances load in Transfer mode, auto-select the
  // chain that actually holds funds (highest balance) if the user hasn't
  // manually chosen one yet.
  useEffect(() => {
    if (mode !== 'transfer' || userPickedSourceRef.current || balances.length === 0) return;
    const currentHasFunds = balances.some((b) => {
      const chain = GATEWAY_SOURCE_CHAINS.find((c) => c.key === sourceKey);
      return chain && b.domain === chain.domain && parseFloat(b.balance) > 0;
    });
    if (currentHasFunds) return;
    const richest = [...balances].sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance))[0];
    const match = GATEWAY_SOURCE_CHAINS.find((c) => c.domain === richest.domain);
    if (match) setSourceKey(match.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, balances]);

  const t = (msg: string, type: ToastType) => setToast({ msg, type });

  const sourceChain = useMemo(
    () => GATEWAY_SOURCE_CHAINS.find((c) => c.key === sourceKey) ?? GATEWAY_SOURCE_CHAINS[0],
    [sourceKey],
  );

  const availableForSource = useMemo(() => {
    if (!sourceChain) return 0;
    const match = balances.find((b) => b.domain === sourceChain.domain);
    return match ? parseFloat(match.balance) : 0;
  }, [balances, sourceChain]);

  const isBusy = phase === 'signing' || phase === 'submitting' || phase === 'minting';
  const isDepositBusy = depositPhase === 'switching' || depositPhase === 'checking' || depositPhase === 'approving' || depositPhase === 'depositing' || depositPhase === 'restoring';
  const amountNum = parseFloat(amount || '0');
  const exceedsThreshold = amountNum > GATEWAY_WARN_THRESHOLD_USDC;

  const runTransferFlow = useCallback(async () => {
    if (!sourceChain) return;
    if (!amount || amountNum <= 0) { t('Enter an amount', 'error'); return; }
    if (amountNum > availableForSource) { t('Amount exceeds your available balance on this chain', 'error'); return; }

    // Exact decimal->micro-USDC conversion (no floating point) — see
    // decimalUsdcToMicro's docstring for why this matters for whole-USDC
    // amounts like "1" that previously could mismatch on-chain balances.
    const amountMicroUsdc = decimalUsdcToMicro(amount);
    // Re-derive available balance fresh from the last-fetched balances list
    // (already a string from Circle's API) rather than round-tripping
    // through parseFloat/Math.round.
    const sourceBalanceEntry = balances.find((b) => b.domain === sourceChain.domain);
    const availableMicroUsdc = sourceBalanceEntry ? decimalUsdcToMicro(sourceBalanceEntry.balance) : 0n;

    try {
      t('Waiting for signature…', 'loading');
      const { burnIntent, signature } = await signBurnIntent({
        sourceDomain: sourceChain.domain,
        sourceUsdcAddress: sourceChain.usdcAddress,
        amountMicroUsdc,
        sourceGasFeeUsd: sourceChain.gasFeeUsd,
        availableMicroUsdc,
      });

      t('Requesting attestation…', 'loading');
      const attestation = await requestAttestation(burnIntent, signature);

      t('Confirming mint on Arc Testnet…', 'loading');
      const hash = await mint(attestation.attestation, attestation.signature);

      t('USDC minted on Arc Testnet! 🎉', 'success');
      // The hook now waits for the mint to actually confirm before
      // resolving, so a refresh here reads post-mint state rather than
      // racing the still-pending transaction.
      refreshBalance();
      refreshArcHistory();
      addHistoryEntry({
        type: 'transfer',
        chainLabel: sourceChain.label,
        amount,
        txHash: hash,
        timestamp: Date.now(),
      });
    } catch {
      // errorMsg from the hook is rendered inline; toast just needs a quick nudge.
      t('Transfer did not complete — see details below', 'error');
    }
  }, [sourceChain, amount, amountNum, availableForSource, balances, signBurnIntent, requestAttestation, mint, refreshBalance, refreshArcHistory, addHistoryEntry]);

  const handleStart = useCallback(() => {
    if (exceedsThreshold) { setPendingConfirm(true); return; }
    runTransferFlow();
  }, [exceedsThreshold, runTransferFlow]);

  const handleRetryMint = useCallback(async () => {
    try {
      t('Retrying mint…', 'loading');
      await mint();
      t('USDC minted on Arc Testnet! 🎉', 'success');
      refreshBalance();
      refreshArcHistory();
    } catch {
      t('Mint retry failed — see details below', 'error');
    }
  }, [mint, refreshBalance, refreshArcHistory]);

  // ── Deposit into GatewayWallet on the source chain ─────────────────────────
  // This is the step Circle's own docs describe as happening outside any
  // dApp UI (approve + deposit on a block explorer). Brought into ArcPay so
  // users don't have to leave the app. Entirely separate from the burn-
  // intent transfer flow above — this only ever touches the source chain.
  const runDepositFlow = useCallback(async () => {
    if (!sourceChain) return;
    if (!amount || amountNum <= 0) { t('Enter an amount', 'error'); return; }

    const amountMicroUsdc = decimalUsdcToMicro(amount);

    try {
      t(`Switching to ${sourceChain.label}…`, 'loading');
      const hash = await deposit({
        chainId: sourceChain.chainId,
        usdcAddress: sourceChain.usdcAddress,
        amountMicroUsdc,
      });
      t('Deposited! Balance updates once the chain finalizes.', 'success');
      // Gateway only reflects a deposit after the source chain finalizes it
      // (seconds to ~19 minutes depending on chain — see design doc's fee/
      // finality table), so an immediate refresh may still show 0. The
      // manual refresh button lets the user check again once it lands.
      refreshBalance();
      addHistoryEntry({
        type: 'deposit',
        chainLabel: sourceChain.label,
        amount,
        txHash: hash,
        timestamp: Date.now(),
      });
    } catch {
      t('Deposit did not complete — see details below', 'error');
    }
  }, [sourceChain, amount, amountNum, deposit, refreshBalance, addHistoryEntry]);

  const handleModeChange = useCallback((next: PanelMode) => {
    setMode(next);
    resetDeposit();
    setPendingConfirm(false);
  }, [resetDeposit]);

  return (
    <div style={{ padding: '32px 36px', height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', overflowY: 'auto' }}>
      <div style={{ marginBottom: 24 }}>
        <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: 'var(--primary)', textTransform: 'uppercase', marginBottom: 6 }}>ArcPay</p>
        <h1 style={{ fontSize: 32, fontWeight: 800, color: 'var(--foreground)', letterSpacing: '-1px' }}>Fund from Any Chain</h1>
        <p style={{ fontSize: 14, color: 'var(--foreground-muted)', marginTop: 4 }}>
          Move USDC from any Gateway-supported chain into Arc Testnet, then fund a Protected Transfer or Batch Payment.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '480px 1fr', gap: 20, flex: 1, minHeight: 0 }}>

        {/* ── Left: transfer form ── */}
        <div style={{ padding: '28px', borderRadius: 14, background: 'var(--surface-card)', border: '1px solid var(--border)', alignSelf: 'flex-start' }}>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
            <Globe size={17} color="var(--primary)" />
            <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--foreground)' }}>Unified Balance</span>
          </div>

          {/* Mode toggle: Deposit (into Gateway) vs Transfer (out to Arc) */}
          <div style={{ display: 'flex', gap: 0, marginBottom: 22, background: 'var(--surface-elevated)', borderRadius: 12, padding: 4, border: '1px solid var(--border)' }}>
            {([
              { key: 'deposit' as const, label: 'Deposit', icon: ArrowDownToLine },
              { key: 'transfer' as const, label: 'Transfer to Arc', icon: Send },
            ]).map(({ key, label, icon: Icon }) => (
              <button key={key} onClick={() => handleModeChange(key)}
                style={{ flex: 1, padding: '9px 0', borderRadius: 9, border: 'none', cursor: 'pointer', background: mode === key ? 'var(--primary)' : 'transparent', color: mode === key ? 'var(--primary-fg)' : 'var(--foreground-muted)', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, transition: 'all 0.2s' }}>
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>

          {mode === 'deposit' && (
            <p style={{ fontSize: 12, color: 'var(--foreground-subtle)', lineHeight: 1.6, marginBottom: 18 }}>
              Deposit USDC you already hold on a source chain into Circle&apos;s Gateway system. This credits your unified balance, which you can then transfer to Arc Testnet.
            </p>
          )}

          {/* Pending finality deposits — deposit pane only (Requirement: these
              only make sense in the context of "I just deposited, is it
              landed yet" which is the Deposit flow, not Transfer). */}
          {mode === 'deposit' && pendingDeposits.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--foreground-subtle)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Pending finality</span>
                <button onClick={refreshBalance} disabled={balanceLoading} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--foreground-muted)', display: 'flex', padding: 4 }}>
                  <RefreshCw size={13} style={{ animation: balanceLoading ? 'spin 1s linear infinite' : 'none' }} />
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {pendingDeposits.map((d) => (
                  <div key={d.transactionHash} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 9, background: 'var(--warning-container)', border: '1px solid rgba(251,191,36,0.3)' }}>
                    <Loader2 size={12} color="var(--warning)" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: 'var(--on-warning-container)' }}>
                      {(parseInt(d.amount) / 1_000_000).toFixed(4)} USDC deposited on {d.label} — waiting for finality, not in your balance yet
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Unified balance breakdown — transfer pane only. Depositing
              doesn't need this context (you're about to add to it, not move
              from it); it only matters once you're picking a source chain to
              transfer FROM. */}
          {mode === 'transfer' && (
            <div style={{ marginBottom: 22 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--foreground-subtle)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Available across chains</span>
                <button onClick={refreshBalance} disabled={balanceLoading} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--foreground-muted)', display: 'flex', padding: 4 }}>
                  <RefreshCw size={13} style={{ animation: balanceLoading ? 'spin 1s linear infinite' : 'none' }} />
                </button>
              </div>
              {balanceError && (
                <p style={{ fontSize: 11, color: 'var(--warning)', marginBottom: 8 }}>
                  <AlertTriangle size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
                  Couldn&apos;t refresh balances — showing last known data.
                </p>
              )}
              {balances.length === 0 ? (
                <div style={{ padding: '16px', borderRadius: 10, background: 'var(--surface-elevated)', border: '1px solid var(--border)', textAlign: 'center' }}>
                  <p style={{ fontSize: 13, color: 'var(--foreground-subtle)' }}>No unified balance found yet</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {balances.map((b) => (
                    <div key={b.domain} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 9, background: 'var(--surface-elevated)', border: '1px solid var(--border)' }}>
                      <span style={{ fontSize: 13, color: 'var(--foreground-muted)' }}>{b.label}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--foreground)' }}>{parseFloat(b.balance).toFixed(4)} USDC</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', marginTop: 4, borderRadius: 9, background: 'var(--primary-container)' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--on-primary-container)' }}>Total unified balance</span>
                    <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--on-primary-container)' }}>{total.toFixed(4)} USDC</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Source chain + amount (shared by both modes) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: 1, color: 'var(--foreground-muted)', textTransform: 'uppercase', marginBottom: 8 }}>
                {mode === 'deposit' ? 'Chain to deposit from' : 'Source Chain'}
              </label>
              <select value={sourceKey} onChange={(e) => { userPickedSourceRef.current = true; setSourceKey(e.target.value); }} disabled={isBusy || isDepositBusy}
                style={{ ...INPUT, cursor: (isBusy || isDepositBusy) ? 'not-allowed' : 'pointer' }}>
                {GATEWAY_SOURCE_CHAINS.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
              {sourceChain && mode === 'transfer' && (
                <p style={{ fontSize: 12, color: 'var(--foreground-subtle)', marginTop: 6 }}>
                  Available on {sourceChain.label}: {availableForSource.toFixed(4)} USDC
                </p>
              )}
              {sourceChain && mode === 'deposit' && (
                <p style={{ fontSize: 12, color: 'var(--foreground-subtle)', marginTop: 6 }}>
                  Your wallet will switch to {sourceChain.label} to approve and deposit.
                </p>
              )}
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: 'var(--foreground-muted)', textTransform: 'uppercase' }}>Amount</label>
                <UsdcBadge />
              </div>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} disabled={isBusy || isDepositBusy}
                type="number" min="0" step="0.0001" placeholder="0.00"
                style={INPUT}
                onFocus={(e) => (e.target.style.borderColor = 'var(--primary)')}
                onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
              />
            </div>

            {mode === 'transfer' ? (
              <>
                {/* Threshold warning modal (inline) */}
                {pendingConfirm && (
                  <div style={{ padding: '14px 16px', borderRadius: 10, background: 'var(--warning-container)', border: '1px solid rgba(251,191,36,0.35)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <AlertTriangle size={16} color="var(--warning)" style={{ flexShrink: 0, marginTop: 1 }} />
                      <p style={{ fontSize: 13, color: 'var(--on-warning-container)', lineHeight: 1.5 }}>
                        You&apos;re about to transfer <strong>{amountNum} USDC</strong>, above the {GATEWAY_WARN_THRESHOLD_USDC} USDC caution threshold. Confirm this is correct before signing.
                      </p>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => { setPendingConfirm(false); runTransferFlow(); }}
                        style={{ flex: 1, padding: '9px', borderRadius: 999, background: 'var(--warning)', color: '#1a1200', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                        Confirm & Continue
                      </button>
                      <button onClick={() => setPendingConfirm(false)}
                        style={{ padding: '9px 16px', borderRadius: 999, background: 'transparent', border: '1px solid var(--border)', color: 'var(--foreground-muted)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Phase status */}
                {phase !== 'idle' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, background: phase === 'error' ? 'var(--error-container)' : phase === 'done' ? 'var(--success-container)' : 'var(--surface-elevated)', border: '1px solid var(--border)' }}>
                    {isBusy && <Loader2 size={14} color="var(--primary)" style={{ animation: 'spin 1s linear infinite' }} />}
                    {phase === 'done' && <CheckCircle2 size={14} color="var(--success)" />}
                    {phase === 'error' && <XCircle size={14} color="var(--error)" />}
                    <span style={{ fontSize: 12, color: phase === 'error' ? 'var(--error)' : phase === 'done' ? 'var(--success)' : 'var(--foreground-muted)' }}>
                      {PHASE_LABEL[phase]}
                    </span>
                  </div>
                )}
                {phase === 'error' && errorMsg && (
                  <p style={{ fontSize: 12, color: 'var(--error)' }}>{errorMsg}</p>
                )}

                {/* Actions */}
                {phase === 'error' && failedStep === 'mint' ? (
                  <button onClick={handleRetryMint} disabled={isBusy}
                    style={{ width: '100%', padding: '13px', borderRadius: 999, background: 'var(--primary)', color: 'var(--primary-fg)', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>
                    Retry Mint
                  </button>
                ) : phase === 'done' ? (
                  <>
                  {arcNativeBalance && (
                    <p style={{ fontSize: 12, color: 'var(--foreground-muted)', textAlign: 'center', marginBottom: 4 }}>
                      Your Arc Testnet balance is now <strong style={{ color: 'var(--foreground)' }}>{arcNativeBalance}</strong>
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button onClick={() => onTabChange('protected')}
                      style={{ flex: 1, padding: '13px', borderRadius: 999, background: 'var(--primary)', color: 'var(--primary-fg)', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                      Protected Transfer <ArrowRight size={15} />
                    </button>
                    <button onClick={() => onTabChange('batch')}
                      style={{ flex: 1, padding: '13px', borderRadius: 999, background: 'var(--surface-elevated)', color: 'var(--foreground)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>
                      Batch Payment
                    </button>
                  </div>
                  </>
                ) : (
                  <button onClick={handleStart} disabled={isBusy || !amount}
                    style={{ width: '100%', padding: '13px', borderRadius: 999, background: 'var(--primary)', color: 'var(--primary-fg)', border: 'none', cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: isBusy || !amount ? 0.6 : 1 }}>
                    {isBusy ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <ShieldCheck size={16} />}
                    {isBusy ? 'Processing…' : 'Sign & Fund from This Chain'}
                  </button>
                )}
              </>
            ) : (
              <>
                {/* Deposit phase status */}
                {depositPhase !== 'idle' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, background: depositPhase === 'error' ? 'var(--error-container)' : depositPhase === 'done' ? 'var(--success-container)' : 'var(--surface-elevated)', border: '1px solid var(--border)' }}>
                    {isDepositBusy && <Loader2 size={14} color="var(--primary)" style={{ animation: 'spin 1s linear infinite' }} />}
                    {depositPhase === 'done' && <CheckCircle2 size={14} color="var(--success)" />}
                    {depositPhase === 'error' && <XCircle size={14} color="var(--error)" />}
                    <span style={{ fontSize: 12, color: depositPhase === 'error' ? 'var(--error)' : depositPhase === 'done' ? 'var(--success)' : 'var(--foreground-muted)' }}>
                      {DEPOSIT_PHASE_LABEL[depositPhase]}
                    </span>
                  </div>
                )}
                {depositPhase === 'error' && depositErrorMsg && (
                  <p style={{ fontSize: 12, color: 'var(--error)' }}>{depositErrorMsg}</p>
                )}
                {depositPhase === 'done' && (
                  <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--surface-elevated)', border: '1px solid var(--border)' }}>
                    <p style={{ fontSize: 12, color: 'var(--foreground-muted)', lineHeight: 1.6 }}>
                      Deposit submitted. Circle needs the source chain to finalize this transaction before it shows up in your unified balance — this can take a few seconds up to ~19 minutes depending on the chain. Check back with the refresh button above.
                    </p>
                  </div>
                )}

                <button onClick={runDepositFlow} disabled={isDepositBusy || !amount}
                  style={{ width: '100%', padding: '13px', borderRadius: 999, background: 'var(--primary)', color: 'var(--primary-fg)', border: 'none', cursor: isDepositBusy ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: isDepositBusy || !amount ? 0.6 : 1 }}>
                  {isDepositBusy ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <ArrowDownToLine size={16} />}
                  {isDepositBusy ? 'Processing…' : 'Approve & Deposit'}
                </button>
                <p style={{ fontSize: 11, color: 'var(--foreground-subtle)', textAlign: 'center' }}>
                  This may prompt two wallet confirmations: one to approve, one to deposit.
                </p>
              </>
            )}
          </div>
        </div>

        {/* ── Right: info panel ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ padding: '20px 22px', borderRadius: 14, background: 'var(--surface-card)', border: '1px solid var(--border)' }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--foreground)', marginBottom: 10 }}>How this works</p>
            <ol style={{ paddingLeft: 18, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(mode === 'deposit' ? [
                'Pick the chain where you already hold USDC in your wallet.',
                'Enter how much to deposit into Circle\'s Gateway system.',
                'Approve the Gateway contract to spend your USDC (first wallet confirmation).',
                'Deposit into Gateway (second wallet confirmation).',
                'Wait for the source chain to finalize, then switch to "Transfer to Arc".',
              ] : [
                'Pick the chain your deposited USDC is on and how much to move.',
                'Sign a transfer request with your wallet — no gas paid here.',
                'ArcPay relays it to Circle for an instant attestation.',
                'Mint the USDC on Arc Testnet with one more wallet confirmation.',
                'Continue into Protected Transfer or Batch Payment as usual.',
              ]).map((step) => (
                <li key={step} style={{ fontSize: 13, color: 'var(--foreground-muted)', lineHeight: 1.5 }}>{step}</li>
              ))}
            </ol>
          </div>

          {mode === 'deposit' && (approveTxHash || depositTxHash) && (
            <div style={{ padding: '16px 18px', borderRadius: 12, background: 'var(--surface-card)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {approveTxHash && (
                <div>
                  <p style={{ fontSize: 11, color: 'var(--foreground-subtle)', marginBottom: 4 }}>Approve transaction</p>
                  <p style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--foreground-muted)', wordBreak: 'break-all' }}>{approveTxHash}</p>
                </div>
              )}
              {depositTxHash && (
                <div>
                  <p style={{ fontSize: 11, color: 'var(--foreground-subtle)', marginBottom: 4 }}>Deposit transaction</p>
                  <p style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--foreground-muted)', wordBreak: 'break-all' }}>{depositTxHash}</p>
                </div>
              )}
            </div>
          )}

          {mode === 'transfer' && mintTxHash && (
            <div style={{ padding: '16px 18px', borderRadius: 12, background: 'var(--surface-card)', border: '1px solid var(--border)' }}>
              <p style={{ fontSize: 11, color: 'var(--foreground-subtle)', marginBottom: 4 }}>Mint transaction</p>
              <p style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--foreground-muted)', wordBreak: 'break-all' }}>{mintTxHash}</p>
              {mintConfirmed && <p style={{ fontSize: 12, color: 'var(--success)', marginTop: 6 }}>Confirmed on Arc Testnet</p>}
            </div>
          )}

          {/* Cross-chain transfer/deposit history — client-tracked (see
              useGatewayHistory), Circle's API doesn't expose a full history
              endpoint for an address. Height is capped and scrolls
              internally instead of stretching to fill the remaining column
              (which looked like an oversized empty box with 0-1 entries). */}
          <div style={{ padding: '20px 22px', borderRadius: 14, background: 'var(--surface-card)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--foreground)', marginBottom: 12 }}>Recent activity</p>
            {historyEntries.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--foreground-subtle)' }}>No cross-chain transfers yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
                {historyEntries.map((h) => {
                  const chain = GATEWAY_SOURCE_CHAINS.find((c) => c.label === h.chainLabel);
                  const href = chain ? `${chain.explorerUrl}/tx/${h.txHash}` : undefined;
                  return (
                    <a
                      key={`${h.txHash}-${h.timestamp}`}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderRadius: 9, background: 'var(--surface-elevated)', border: '1px solid var(--border)', textDecoration: 'none' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {h.type === 'deposit' ? <ArrowDownToLine size={13} color="var(--foreground-muted)" /> : <Send size={13} color="var(--foreground-muted)" />}
                        <div>
                          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
                            {h.type === 'deposit' ? 'Deposited' : 'Transferred to Arc'} {h.amount} USDC
                          </p>
                          <p style={{ fontSize: 11, color: 'var(--foreground-subtle)' }}>
                            {h.chainLabel} · {new Date(h.timestamp).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {toast && <Toast message={toast.msg} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
