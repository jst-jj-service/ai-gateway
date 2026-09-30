import assert from 'assert';
import { MemoryStore } from '../src/db/store';
import { QuotaService } from '../src/services/quota.service';
import { UsageService } from '../src/services/usage.service';
import { formatTokens, calculatePercentage, calculateCacheHitRatio } from '../src/utils/formatters';

export async function runQuotaAndUsageTests() {
  console.log('▶ Testing Quota, Usage & Token Formatting...');

  // Test 1: Token Formatters
  assert.strictEqual(formatTokens(500), '500');
  assert.strictEqual(formatTokens(45_200), '45.2K');
  assert.strictEqual(formatTokens(1_250_000), '1.25M');
  assert.strictEqual(formatTokens(2_400_000_000), '2.40B');
  assert.strictEqual(calculatePercentage(25, 100), 25);
  assert.strictEqual(calculateCacheHitRatio(300, 1000), 30);

  // Test 2: Quota Initial State
  const store = new MemoryStore();
  const quotaService = new QuotaService(store);
  const usageService = new UsageService(store);

  const user = await store.createUser({
    email: 'quota_tester@example.com',
    passwordHash: 'dummy'
  });

  const initialHasQuota = await quotaService.hasRemainingQuota(user.id);
  assert.strictEqual(initialHasQuota, false, 'New user should have 0 quota initially');

  // Test 3: Credit Quota (e.g. from CDK redemption)
  await quotaService.creditQuota(user.id, 5_000_000n);
  const hasQuotaAfterCredit = await quotaService.hasRemainingQuota(user.id);
  assert.strictEqual(hasQuotaAfterCredit, true);

  // Test 4: Record Usage and verify deduction
  await usageService.recordApiUsage({
    userId: user.id,
    model: 'gpt-4o',
    promptTokens: 1200,
    completionTokens: 800,
    cachedTokens: 400,
    totalTokens: 2000,
    requestDurationMs: 450,
    statusCode: 200,
    isStream: false
  });

  const quotaAfter = await quotaService.getQuota(user.id);
  assert.strictEqual(quotaAfter.usedTokens, 2000n);
  assert.strictEqual(quotaAfter.cachedTokens, 400n);
  assert.strictEqual(quotaAfter.remainingTokens, 5_000_000n - 2000n);

  // Test 5: Dashboard statistics
  const dashboard = await usageService.getUserDashboardData(user.id);
  assert.strictEqual(dashboard.summary.usedTokens, 2000);
  assert.strictEqual(dashboard.summary.cachedTokens, 400);
  assert.strictEqual(dashboard.summary.promptTokens, 1200);
  assert.strictEqual(dashboard.summary.completionTokens, 800);
  assert.strictEqual(dashboard.models[0].model, 'gpt-4o');
  assert.strictEqual(dashboard.recentLogs.length, 1);
  assert.strictEqual(dashboard.recentLogs[0].statusCode, 200);

  // Test 6: Optimistic Quota Reservation & Exhaustion
  const user2 = await store.createUser({
    email: 'concurrent_user@example.com',
    passwordHash: 'dummy'
  });
  await quotaService.creditQuota(user2.id, 500n);

  // Test 7: Concurrent requests cannot bypass quota (Anti-Free-Usage)
  // 10 concurrent requests each attempting to reserve 100 tokens
  const reservations = await Promise.all(
    Array.from({ length: 10 }).map(() => quotaService.reserveQuota(user2.id, 100, 50))
  );

  const successfulReservations = reservations.filter(r => r.success);
  const rejectedReservations = reservations.filter(r => !r.success);

  assert.strictEqual(successfulReservations.length, 5, 'Exactly 5 requests should reserve 100 tokens out of 500');
  assert.strictEqual(rejectedReservations.length, 5, 'The remaining 5 concurrent requests must be rejected immediately');

  const quotaAfterConcurrentReserve = await quotaService.getQuota(user2.id);
  assert.strictEqual(quotaAfterConcurrentReserve.remainingTokens, 0n, 'Remaining tokens should be exactly 0 after 5 reservations');

  // Test 8: Post-response reconciliation - Request used fewer tokens than reserved (refunds difference)
  const res1 = successfulReservations[0];
  // Reserved 100, actual used = 40 (prompt 30, completion 10, cached 5)
  await quotaService.reconcileQuota(user2.id, res1.reservationId, 40, 5, 200);
  const quotaAfterRefund = await quotaService.getQuota(user2.id);
  assert.strictEqual(quotaAfterRefund.remainingTokens, 60n, '60 unused reserved tokens should be refunded to user balance');
  assert.strictEqual(quotaAfterRefund.usedTokens, 40n, 'Used tokens should reflect actual 40 tokens');
  assert.strictEqual(quotaAfterRefund.cachedTokens, 5n, 'Cached tokens should reflect 5');

  // Test 9: Post-response reconciliation - Upstream total failure (refunds full reservation)
  const res2 = successfulReservations[1];
  // Upstream 500 error: 0 tokens consumed
  await quotaService.reconcileQuota(user2.id, res2.reservationId, 0, 0, 500);
  const quotaAfterFailRefund = await quotaService.getQuota(user2.id);
  assert.strictEqual(quotaAfterFailRefund.remainingTokens, 160n, 'Full 100 tokens should be refunded when request fails before consuming tokens');

  // Test 10: Partial failure during streaming (accurate accounting, no negative quota)
  const res3 = successfulReservations[2];
  // Stream aborted midway after generating 25 completion tokens + 15 prompt tokens = 40 tokens consumed
  await quotaService.reconcileQuota(user2.id, res3.reservationId, 40, 0, 502);
  const quotaAfterStreamAbort = await quotaService.getQuota(user2.id);
  assert.strictEqual(quotaAfterStreamAbort.remainingTokens, 220n, 'Unused 60 tokens refunded, 40 partial consumed tokens retained');
  assert.strictEqual(quotaAfterStreamAbort.usedTokens, 80n, 'Used tokens increased by 40');

  // Test 11: Request consumed more tokens than reserved (prevents negative quota)
  const user3 = await store.createUser({
    email: 'boundary_user@example.com',
    passwordHash: 'dummy'
  });
  await quotaService.creditQuota(user3.id, 50n);
  const resOver = await quotaService.reserveQuota(user3.id, 50, 10);
  assert.strictEqual(resOver.success, true);
  // Actual used = 120 (more than 50 reserved)
  await quotaService.reconcileQuota(user3.id, resOver.reservationId, 120, 0, 200);
  const quotaBoundary = await quotaService.getQuota(user3.id);
  assert.strictEqual(quotaBoundary.remainingTokens, 0n, 'Remaining tokens must never be negative');
  assert.strictEqual(quotaBoundary.usedTokens, 120n, 'Used tokens accurately tracked');

  // Test 12: Double reconciliation idempotency
  // Reconciling an already-reconciled reservation must be a safe no-op and NOT deduct again
  const quotaBeforeDuplicate = await quotaService.getQuota(user3.id);
  await quotaService.reconcileQuota(user3.id, resOver.reservationId, 50, 0, 200);
  const quotaAfterDuplicate = await quotaService.getQuota(user3.id);
  assert.strictEqual(quotaAfterDuplicate.remainingTokens, quotaBeforeDuplicate.remainingTokens, 'Duplicate reconciliation must not change remaining quota');
  assert.strictEqual(quotaAfterDuplicate.usedTokens, quotaBeforeDuplicate.usedTokens, 'Duplicate reconciliation must not increase used tokens');

  // Test 13: Negative token deduction prevention (Anti-Free-Usage tampering)
  await quotaService.creditQuota(user3.id, 100n);
  const quotaBeforeNegative = await quotaService.getQuota(user3.id);
  assert.strictEqual(quotaBeforeNegative.remainingTokens, 100n);
  // Attempt to pass negative token deduction to artificially inflate quota
  await store.deductTokensFromQuota(user3.id, -500, -100);
  const quotaAfterNegative = await quotaService.getQuota(user3.id);
  assert.strictEqual(quotaAfterNegative.remainingTokens, 100n, 'Negative tokens must be clamped to 0 and cannot grant free quota');

  // Test 14: Clean shutdown refunds active in-flight reservations
  const user4 = await store.createUser({
    email: 'shutdown_user@example.com',
    passwordHash: 'dummy'
  });
  await quotaService.creditQuota(user4.id, 300n);
  const resShutdown = await quotaService.reserveQuota(user4.id, 150, 50);
  assert.strictEqual(resShutdown.success, true);
  const quotaDuringFlight = await quotaService.getQuota(user4.id);
  assert.strictEqual(quotaDuringFlight.remainingTokens, 150n, '150 tokens reserved');

  // When store is closed, unconsumed in-flight reservations must be refunded
  store.close();
  const quotaAfterClose = await quotaService.getQuota(user4.id);
  assert.strictEqual(quotaAfterClose.remainingTokens, 300n, 'Unconsumed reservations must be fully refunded on store close');

  console.log('✓ Quota, Concurrency, Reservation & Reconciliation tests passed successfully!');
}
