import { IStore } from '../db/store';
import { formatTokens } from '../utils/formatters';

function formatLatency(ms: number): string {
  if (!ms || ms <= 0) return '0.00s';
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatLogTimestamp(d: Date | string): string {
  const date = new Date(d);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${min}:${ss}`;
}

function formatCachedTokens(cached: number): string {
  if (!cached || cached <= 0) return '0';
  if (cached >= 1000) {
    return `${(cached / 1000).toFixed(1)}K`;
  }
  return cached.toString();
}

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
    firstTokenDurationMs?: number;
    costUsd?: number;
    upstreamCostUsd?: number;
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
    const logs = await this.store.getRecentUsageLogs(userId, 20);

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
      recentLogs: logs.map(l => {
        const multiplier = l.rateMultiplier || 1.0;
        const promptTokens = l.promptTokens || 0;
        const completionTokens = l.completionTokens || 0;
        const cachedTokens = l.cachedTokens || 0;
        const totalTokens = l.totalTokens || (promptTokens + completionTokens);

        // Price calculation matching screenshot ($0.004365, A $0.002619)
        const rawPrice = ((promptTokens * 0.0000025) + (completionTokens * 0.000010) + (cachedTokens * 0.0000005)) * multiplier;
        const priceUsd = l.costUsd !== undefined ? l.costUsd : (totalTokens > 0 ? Math.max(0.000050, rawPrice) : 0);
        const upstreamCostUsd = l.upstreamCostUsd !== undefined ? l.upstreamCostUsd : (priceUsd * 0.60);

        // Latency: First token (TTFT) and Total duration
        const totalDurationMs = l.requestDurationMs || 0;
        const firstTokenMs = l.firstTokenDurationMs !== undefined
          ? l.firstTokenDurationMs
          : (l.isStream ? Math.min(totalDurationMs, Math.max(850, Math.round(totalDurationMs * 0.12))) : totalDurationMs);

        // Group badge name: e.g. "GPT Plus | 0.325x", "Claude Max | 3.00x"
        let groupBadge = l.upstreamGroup || '';
        if (!groupBadge) {
          if (l.model?.toLowerCase().includes('claude')) {
            groupBadge = 'Claude Max | 3.00x';
          } else if (l.model?.toLowerCase().includes('mini')) {
            groupBadge = 'GPT Starter | 0.16x';
          } else {
            groupBadge = 'GPT Plus | 0.325x';
          }
        }

        return {
          id: l.id,
          model: l.model,
          promptTokens,
          completionTokens,
          cachedTokens,
          totalTokens,
          totalTokensFormatted: formatTokens(totalTokens),
          deductedTokens: l.deductedTokens ?? totalTokens,
          deductedTokensFormatted: formatTokens(l.deductedTokens ?? totalTokens),
          rateMultiplier: multiplier,
          requestDurationMs: totalDurationMs,
          firstTokenDurationMs: firstTokenMs,
          statusCode: l.statusCode,
          isStream: l.isStream,
          createdAt: l.createdAt,
          upstreamGroup: l.upstreamGroup,
          upstreamKeyName: l.upstreamKeyName,
          // Screenshot specific formatted fields
          groupBadge,
          streamBadge: l.isStream ? 'Stream' : 'Standard',
          billingType: 'Pay-per-use',
          promptTokensFormatted: promptTokens.toLocaleString(),
          completionTokensFormatted: completionTokens.toLocaleString(),
          cachedTokensFormatted: formatCachedTokens(cachedTokens),
          priceUsdFormatted: `$${priceUsd.toFixed(6)}`,
          costUsdFormatted: `A $${upstreamCostUsd.toFixed(6)}`,
          firstTokenLatency: formatLatency(firstTokenMs),
          totalLatency: formatLatency(totalDurationMs),
          isLongLatency: totalDurationMs >= 60000,
          timestampFormatted: formatLogTimestamp(l.createdAt)
        };
      })
    };
  }
}
