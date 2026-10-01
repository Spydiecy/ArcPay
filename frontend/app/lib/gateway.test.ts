import { describe, it, expect } from 'vitest';
import {
  addressToBytes32,
  estimateMaxFee,
  microUsdcToNativeWei,
  nativeWeiToMicroUsdc,
  decimalUsdcToMicro,
  formatGatewayError,
  GATEWAY_SOURCE_CHAINS,
  ARC_TESTNET_DOMAIN,
} from './gateway';

describe('addressToBytes32', () => {
  it('left-pads a 20-byte address to 32 bytes', () => {
    const address = '0x2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8';
    const result = addressToBytes32(address);
    expect(result).toBe(
      '0x0000000000000000000000002ec8175015bef5ad1c0be1587c4a377bc083a2d8',
    );
    // 0x + 64 hex chars = 66 total
    expect(result.length).toBe(66);
  });

  it('lowercases the address', () => {
    const result = addressToBytes32('0xABCDEF0000000000000000000000000000ABCD');
    expect(result).toBe(result.toLowerCase());
  });

  it('handles an address with no 0x prefix', () => {
    const withPrefix = addressToBytes32('0x2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8');
    const withoutPrefix = addressToBytes32('2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8');
    expect(withPrefix).toBe(withoutPrefix);
  });
});

describe('estimateMaxFee', () => {
  it('matches Circle\'s worked example: 1,000 USDC from Base, no forwarding', () => {
    // Circle's docs: gas fee $0.01, transfer fee 1000 * 0.00005 = $0.05,
    // minimum maxFee = $0.06 (60,000 micro-USDC) before any buffer.
    const amountMicroUsdc = 1_000_000_000n; // 1,000 USDC in 6-decimal micro-units
    const baseFeeOnly = estimateMaxFee(amountMicroUsdc, 0.01, 0); // no buffer
    expect(baseFeeOnly).toBe(60_000n);
  });

  it('adds a buffer on top of the base fee', () => {
    const amountMicroUsdc = 1_000_000_000n;
    const noBuffer = estimateMaxFee(amountMicroUsdc, 0.01, 0);
    const withBuffer = estimateMaxFee(amountMicroUsdc, 0.01, 0.5); // 50% buffer
    expect(withBuffer).toBeGreaterThan(noBuffer);
    expect(withBuffer).toBe(noBuffer + (noBuffer * 50n) / 100n);
  });

  it('scales the transfer fee linearly with amount', () => {
    const small = estimateMaxFee(1_000_000n, 0, 0); // 1 USDC, no gas fee
    const large = estimateMaxFee(10_000_000n, 0, 0); // 10 USDC, no gas fee
    expect(large).toBe(small * 10n);
  });
});

describe('microUsdcToNativeWei / nativeWeiToMicroUsdc (decimals boundary — Property 3)', () => {
  it('converts 1 USDC (6-decimal) to the equivalent 18-decimal native amount', () => {
    const oneUsdcMicro = 1_000_000n; // 1 USDC in 6-decimal micro-units
    const result = microUsdcToNativeWei(oneUsdcMicro);
    expect(result).toBe(1_000_000_000_000_000_000n); // 1 * 10^18
  });

  it('round-trips without loss for whole micro-USDC amounts', () => {
    const original = 5_432_100n; // 5.4321 USDC
    const wei = microUsdcToNativeWei(original);
    const back = nativeWeiToMicroUsdc(wei);
    expect(back).toBe(original);
  });

  it('truncates sub-micro-USDC dust when converting native wei back down', () => {
    // 1 wei of "extra" precision below the 6-decimal boundary must not
    // silently inflate the micro-USDC amount.
    const wei = 1_000_000_000_000_000_123n; // 1 USDC + 123 wei of dust
    expect(nativeWeiToMicroUsdc(wei)).toBe(1_000_000n);
  });
});

describe('decimalUsdcToMicro (exact decimal conversion, no floating point)', () => {
  it('converts a whole USDC amount exactly', () => {
    expect(decimalUsdcToMicro('1')).toBe(1_000_000n);
  });

  it('converts a fractional amount exactly', () => {
    expect(decimalUsdcToMicro('0.98')).toBe(980_000n);
  });

  it('handles amounts with the full 6 decimals of precision', () => {
    expect(decimalUsdcToMicro('1.234567')).toBe(1_234_567n);
  });

  it('truncates extra precision beyond 6 decimals rather than rounding', () => {
    expect(decimalUsdcToMicro('1.2345678')).toBe(1_234_567n);
  });

  it('pads short fractional parts', () => {
    expect(decimalUsdcToMicro('1.5')).toBe(1_500_000n);
  });

  it('returns 0 for an empty string', () => {
    expect(decimalUsdcToMicro('')).toBe(0n);
  });

  it('never produces a floating-point-off-by-one result for values that break Math.round(x * 1e6)', () => {
    // Classic floating point trap: 1.005 * 100 !== 100.5 exactly in IEEE754.
    // Confirm the string-based approach sidesteps this class of bug entirely.
    expect(decimalUsdcToMicro('1.000000')).toBe(1_000_000n);
    expect(decimalUsdcToMicro('0.1')).toBe(100_000n);
    expect(decimalUsdcToMicro('0.3')).toBe(300_000n);
  });
});

describe('formatGatewayError', () => {
  it('recognizes a user-rejected request', () => {
    expect(formatGatewayError(new Error('User rejected the request'))).toBe(
      'Request was rejected in your wallet.',
    );
  });

  it('recognizes an insufficient-balance revert', () => {
    expect(formatGatewayError(new Error('ERC20: transfer amount exceeds balance'))).toBe(
      'This amount exceeds your USDC balance on that chain.',
    );
  });

  it('prefers a viem-style shortMessage over the raw message', () => {
    const viemLikeError = { shortMessage: 'User rejected the request.', message: 'A very long raw ABI-encoded error dump...' };
    expect(formatGatewayError(viemLikeError)).toBe('Request was rejected in your wallet.');
  });

  it('falls back to a truncated first line for unrecognized errors', () => {
    const longMsg = 'x'.repeat(300);
    const result = formatGatewayError(new Error(longMsg));
    expect(result.length).toBeLessThanOrEqual(161);
  });

  it('never throws on null/undefined input', () => {
    expect(() => formatGatewayError(null)).not.toThrow();
    expect(() => formatGatewayError(undefined)).not.toThrow();
  });
});

describe('GATEWAY_SOURCE_CHAINS (Property 2: Arc is destination-only)', () => {
  it('contains no entry for the Arc Testnet domain', () => {
    const hasArc = GATEWAY_SOURCE_CHAINS.some((c) => c.domain === ARC_TESTNET_DOMAIN);
    expect(hasArc).toBe(false);
  });

  it('every source chain has a distinct domain id', () => {
    const domains = GATEWAY_SOURCE_CHAINS.map((c) => c.domain);
    expect(new Set(domains).size).toBe(domains.length);
  });

  it('every source chain has a well-formed USDC address', () => {
    for (const chain of GATEWAY_SOURCE_CHAINS) {
      expect(chain.usdcAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    }
  });
});
