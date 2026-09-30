import { IStore } from '../db/store';
import { UserQuota, FormattedTokenUsage } from '../types';
import { formatTokens, calculatePercentage } from '../utils/formatters';

export class QuotaService {
  constructor(private store: IStore) {}

  public async getQuota(userId: string): Promise<UserQuota> {
    return this.store.getUserQuota(userId);
  }

  /**
   * Checks whether the user has at least 1 remaining token (or estimated amount).
   */
  public async hasRemainingQuota(userId: string, minRequired = 1): Promise<boolean> {
    const quota = await this.store.getUserQuota(userId);
    const safeMin = Number.isFinite(minRequired) && minRequired >= 1 ? BigInt(Math.floor(minRequired)) : 1n;
    return quota.remainingTokens >= safeMin;
  }

  public async creditQuota(userId: string, tokens: bigint): Promise<UserQuota> {
    return this.store.addTokensToQuota(userId, tokens);
  }

  public async deductUsage(userId: string, tokensUsed: number, cachedTokens: number): Promise<UserQuota> {
    return this.store.deductTokensFromQuota(userId, tokensUsed, cachedTokens);
  }

  /**
   * Optimistically reserves token quota before forwarding to upstream to prevent concurrency race conditions.
   */
  public async reserveQuota(userId: string, tokensToReserve: number, minRequired = 1) {
    return this.store.reserveQuota(userId, tokensToReserve, minRequired);
  }

  /**
   * Reconciles actual token usage after upstream call completes.
   */
  public async reconcileQuota(
    userId: string,
    reservationId: string,
    actualTokensUsed: number,
    cachedTokens: number,
    statusCode: number
  ) {
    return this.store.reconcileQuota(userId, reservationId, actualTokensUsed, cachedTokens, statusCode);
  }

  /**
   * Cancels a reservation and restores the reserved tokens.
   */
  public async cancelReservation(reservationId: string) {
    return this.store.cancelReservation(reservationId);
  }

  public async getFormattedQuota(userId: string): Promise<FormattedTokenUsage> {
    const quota = await this.store.getUserQuota(userId);
    const summary = await this.store.getUserUsageSummary(userId);

    const total = Number(quota.totalTokens);
    const used = Number(quota.usedTokens);
    const remaining = Number(quota.remainingTokens);
    const cached = Number(quota.cachedTokens);

    return {
      totalTokens: total,
      totalTokensFormatted: formatTokens(total),
      usedTokens: used,
      usedTokensFormatted: formatTokens(used),
      remainingTokens: remaining,
      remainingTokensFormatted: formatTokens(remaining),
      cachedTokens: cached,
      cachedTokensFormatted: formatTokens(cached),
      promptTokens: summary.promptTokens,
      promptTokensFormatted: formatTokens(summary.promptTokens),
      completionTokens: summary.completionTokens,
      completionTokensFormatted: formatTokens(summary.completionTokens),
      percentUsed: calculatePercentage(used, total),
      cacheHitRatio: summary.promptTokens > 0 ? calculatePercentage(cached, summary.promptTokens) : 0
    };
  }
}
