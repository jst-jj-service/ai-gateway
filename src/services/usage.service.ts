import { IStore } from '../db/store';
import { formatTokens } from '../utils/formatters';

export class UsageService {
  constructor(private store: IStore) {}

  public async recordApiUsage(data: {
    userId: string;
    apiKeyId?: string | null;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    totalTokens: number;
    deductedTokens?: number;
    rateMultiplier?: number;
    requestDurationMs: number;
    statusCode: number;
    isStream: boolean;
    skipQuotaDeduct?: boolean;
    upstreamGroup?: string;
    upstreamKeyName?: string;
  }) {
    // Record log in store
    const record = await this.store.recordUsage(data);

    // If successful request and not already handled via reservation & reconcile, deduct from quota
    if (!data.skipQuotaDeduct && data.statusCode === 200 && data.totalTokens > 0) {
      await this.store.deductTokensFromQuota(data.userId, data.totalTokens, data.cachedTokens);
    }

    return record;
  }

  public async getUserDashboardData(userId: string) {
    const summary = await this.store.getUserUsageSummary(userId);
    const trends = await this.store.getUserUsageTrends(userId, 14);
    const models = await this.store.getUserModelBreakdown(userId);
    const logs = await this.store.getRecentUsageLogs(userId, 15);

    return {
      summary: {
        ...summary,
        totalTokensFormatted: formatTokens(summary.totalTokens),
        usedTokensFormatted: formatTokens(summary.usedTokens),
        remainingTokensFormatted: formatTokens(summary.remainingTokens),
        cachedTokensFormatted: formatTokens(summary.cachedTokens),
        promptTokensFormatted: formatTokens(summary.promptTokens),
        completionTokensFormatted: formatTokens(summary.completionTokens)
      },
      trends: trends.map(t => ({
        ...t,
        totalTokensFormatted: formatTokens(t.totalTokens),
        cachedTokensFormatted: formatTokens(t.cachedTokens)
      })),
      models: models.map(m => ({
        ...m,
        totalTokensFormatted: formatTokens(m.totalTokens),
        cachedTokensFormatted: formatTokens(m.cachedTokens)
      })),
      recentLogs: logs.map(l => ({
        id: l.id,
        model: l.model,
        promptTokens: l.promptTokens,
        completionTokens: l.completionTokens,
        cachedTokens: l.cachedTokens,
        totalTokens: l.totalTokens,
        totalTokensFormatted: formatTokens(l.totalTokens),
        deductedTokens: l.deductedTokens ?? l.totalTokens,
        deductedTokensFormatted: formatTokens(l.deductedTokens ?? l.totalTokens),
        rateMultiplier: l.rateMultiplier,
        requestDurationMs: l.requestDurationMs,
        statusCode: l.statusCode,
        isStream: l.isStream,
        createdAt: l.createdAt,
        upstreamGroup: l.upstreamGroup,
        upstreamKeyName: l.upstreamKeyName
      }))
    };
  }
}
