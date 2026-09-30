/**
 * Formats a number of tokens into a human-readable string:
 * 1,200,000 -> "1.20M"
 * 45,000 -> "45.0K"
 * 500 -> "500"
 */
export function formatTokens(tokens: number | bigint): string {
  const num = typeof tokens === 'bigint' ? Number(tokens) : tokens;

  if (num >= 1_000_000_000) {
    return (num / 1_000_000_000).toFixed(2) + 'B';
  }
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(2) + 'M';
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1) + 'K';
  }
  return num.toLocaleString();
}

/**
 * Calculates percentage safely (avoiding divide-by-zero).
 */
export function calculatePercentage(part: number, total: number): number {
  if (!total || total <= 0) return 0;
  const pct = (part / total) * 100;
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}

/**
 * Calculates cache hit ratio: cachedTokens / promptTokens.
 */
export function calculateCacheHitRatio(cachedTokens: number, promptTokens: number): number {
  if (!promptTokens || promptTokens <= 0) return 0;
  const ratio = (cachedTokens / promptTokens) * 100;
  return Math.min(100, Math.max(0, Math.round(ratio * 10) / 10));
}
