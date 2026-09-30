import { IStore } from '../db/store';
import { Cdk } from '../types';
import { generateCdkBatch, isValidCdkFormat } from '../utils/cdk-generator';
import { formatTokens } from '../utils/formatters';

export interface CreateBatchCdkParams {
  count: number;
  tokenQuota: number | bigint; // e.g. 1_000_000 for 1M
  tier?: string;
  expiresInDays?: number;
}

export class CdkService {
  constructor(private store: IStore) {}

  public async generateBatch(params: CreateBatchCdkParams): Promise<Cdk[]> {
    const { count, tokenQuota, tier = 'standard', expiresInDays } = params;
    if (count < 1 || count > 500) {
      throw new Error('Batch count must be between 1 and 500');
    }

    if (typeof tokenQuota === 'number' && (!Number.isFinite(tokenQuota) || tokenQuota <= 0)) {
      throw new Error('Token quota must be a positive number');
    }

    const quotaBig = typeof tokenQuota === 'number' ? BigInt(Math.floor(tokenQuota)) : BigInt(tokenQuota);
    if (quotaBig <= 0n) {
      throw new Error('Token quota must be greater than 0');
    }

    const codes = generateCdkBatch(count);
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null;

    const items = codes.map(code => ({
      code,
      tokenQuota: quotaBig,
      tier,
      expiresAt
    }));

    return this.store.createCdkBatch(items);
  }

  public async redeem(code: string, userId: string): Promise<{
    success: boolean;
    tokensAdded: number;
    tokensAddedFormatted: string;
    error?: string;
  }> {
    if (!code || typeof code !== 'string') {
      return {
        success: false,
        tokensAdded: 0,
        tokensAddedFormatted: '0',
        error: 'Please enter a CDK activation code.'
      };
    }

    const cleanCode = code.trim().toUpperCase();
    if (!isValidCdkFormat(cleanCode)) {
      return {
        success: false,
        tokensAdded: 0,
        tokensAddedFormatted: '0',
        error: 'Invalid CDK format. Expected format: CDK-XXXX-XXXX-XXXX'
      };
    }

    const result = await this.store.redeemCdk(cleanCode, userId);
    if (!result.success) {
      return {
        success: false,
        tokensAdded: 0,
        tokensAddedFormatted: '0',
        error: result.error
      };
    }

    const numTokens = Number(result.tokensAdded);
    return {
      success: true,
      tokensAdded: numTokens,
      tokensAddedFormatted: formatTokens(numTokens)
    };
  }

  public async getAllCdks(): Promise<Array<{
    id: string;
    code: string;
    tokenQuota: number;
    tokenQuotaFormatted: string;
    tier: string;
    isRedeemed: boolean;
    expiresAt: Date | null;
    createdAt: Date;
    redeemedByEmail?: string;
    redeemedAt?: Date;
  }>> {
    const cdks = await this.store.getAllCdks();
    return cdks.map(c => {
      const quotaNum = Number(c.tokenQuota);
      return {
        id: c.id,
        code: c.code,
        tokenQuota: quotaNum,
        tokenQuotaFormatted: formatTokens(quotaNum),
        tier: c.tier,
        isRedeemed: c.isRedeemed,
        expiresAt: c.expiresAt,
        createdAt: c.createdAt,
        redeemedByEmail: c.redemption?.userEmail,
        redeemedAt: c.redemption?.redeemedAt
      };
    });
  }

  public async exportCdksAsCsv(): Promise<string> {
    const cdks = await this.getAllCdks();
    const header = 'Code,Quota,QuotaFormatted,Tier,Status,RedeemedBy,RedeemedAt,CreatedAt\n';
    const rows = cdks.map(c => {
      const status = c.isRedeemed ? 'REDEEMED' : (c.expiresAt && c.expiresAt.getTime() < Date.now() ? 'EXPIRED' : 'AVAILABLE');
      return `"${c.code}",${c.tokenQuota},"${c.tokenQuotaFormatted}","${c.tier}","${status}","${c.redeemedByEmail || ''}","${c.redeemedAt?.toISOString() || ''}","${c.createdAt.toISOString()}"`;
    });
    return header + rows.join('\n');
  }
}
