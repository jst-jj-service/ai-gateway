import crypto from 'crypto';

export const CHARSET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Generates a formatted CDK activation key: CDK-XXXX-XXXX-XXXX
 * Total 12 alphanumeric characters in 3 groups of 4.
 * Uses cryptographically secure unbiased random selection (eliminating modulo bias).
 */
export function generateCdkCode(): string {
  let result = '';
  const charsetLen = CHARSET.length;

  for (let i = 0; i < 12; i++) {
    // crypto.randomInt uses rejection sampling internally to avoid modulo bias
    const index = crypto.randomInt(0, charsetLen);
    result += CHARSET[index];
  }

  return `CDK-${result.slice(0, 4)}-${result.slice(4, 8)}-${result.slice(8, 12)}`;
}

/**
 * Validates the syntactic format of a CDK code.
 */
export function isValidCdkFormat(code: string): boolean {
  const pattern = /^CDK-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/i;
  return pattern.test(code.trim());
}

/**
 * Generates a batch of unique CDK codes.
 */
export function generateCdkBatch(count: number): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    codes.add(generateCdkCode());
  }
  return Array.from(codes);
}
