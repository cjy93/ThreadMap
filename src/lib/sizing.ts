// Deterministic message-count node sizing shared by server and browser.
// D(n) = sqrt(Dmin² + (Dmax² − Dmin²) × clamp(ln(1+n) / ln(1+C), 0, 1))

export interface SizingConfig {
  minDiameterPx: number;
  maxDiameterPx: number;
  referenceCount: number;
}

export const DEFAULT_SIZING: SizingConfig = Object.freeze({
  minDiameterPx: 64,
  maxDiameterPx: 220,
  referenceCount: 10_000,
});

export class SizingConfigError extends Error {}

export function validateSizingConfig(cfg: SizingConfig): SizingConfig {
  const { minDiameterPx: dmin, maxDiameterPx: dmax, referenceCount: c } = cfg;
  if (!Number.isFinite(dmin) || !Number.isFinite(dmax) || dmin <= 0 || dmax <= 0) {
    throw new SizingConfigError('node diameters must be finite positive numbers');
  }
  if (!(dmin < dmax)) throw new SizingConfigError('MAP_NODE_MIN_DIAMETER_PX must be < MAP_NODE_MAX_DIAMETER_PX');
  if (!Number.isSafeInteger(c) || c <= 0) {
    throw new SizingConfigError('MAP_NODE_SIZE_REFERENCE_COUNT must be a positive safe integer');
  }
  return cfg;
}

/** Revision string recorded with map responses and release evidence. */
export function sizingRevision(cfg: SizingConfig): string {
  return `log-area-v1:${cfg.minDiameterPx}:${cfg.maxDiameterPx}:${cfg.referenceCount}`;
}

/**
 * Circle body diameter in unzoomed graph pixels. Returns null for an unknown
 * count: callers must render a neutral loading/unavailable state rather than
 * a fabricated size.
 */
export function nodeDiameter(count: number | null | undefined, cfg: SizingConfig = DEFAULT_SIZING): number | null {
  if (count === null || count === undefined) return null;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new SizingConfigError(`invalid matching count: ${String(count)}`);
  }
  const { minDiameterPx: dmin, maxDiameterPx: dmax, referenceCount: c } = cfg;
  const t = Math.min(1, Math.max(0, Math.log1p(count) / Math.log1p(c)));
  return Math.sqrt(dmin * dmin + (dmax * dmax - dmin * dmin) * t);
}

export const SIZE_LEGEND = 'Size represents matching messages; scale compressed';

export function formatCount(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'message' : 'messages'}`;
}
