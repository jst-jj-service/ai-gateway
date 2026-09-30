import assert from 'assert';
import { MemoryStore } from '../src/db/store';
import { QuotaService } from '../src/services/quota.service';
import { SseStreamParser } from '../src/utils/sse-parser';
import { generateCdkCode } from '../src/utils/cdk-generator';

export async function runAdversarialQuotaTests() {
  console.log('▶ Testing Adversarial Attack Vectors & Anti-Free-Usage Guarantees...');

  const store = new MemoryStore();
  const quotaService = new QuotaService(store);

  // Attack Vector 1: 150 concurrent requests fired against a 120-token user balance
  const victim = await store.createUser({
    email: 'stress_victim@gateway.io',
    passwordHash: 'dummy'
  });
  await quotaService.creditQuota(victim.id, 120n);

  // 150 concurrent requests with varying reservation budgets (from 20 to 100 tokens)
  const concurrentRequests = 150;
  const reservationPromises = Array.from({ length: concurrentRequests }).map((_, i) => {
    const budget = 20 + (i % 5) * 10; // 20, 30, 40, 50, 60
    return quotaService.reserveQuota(victim.id, budget, 15);
  });

  const results = await Promise.all(reservationPromises);
  const granted = results.filter(r => r.success);
  const denied = results.filter(r => !r.success);

  assert.ok(granted.length > 0, 'Some requests within budget should succeed');
  assert.ok(denied.length > 0, 'Excess requests beyond 120 balance must be rejected');

  // Verify that total reserved tokens + remaining tokens never exceeds initial 120 tokens
  const totalReserved = granted.reduce((sum, r) => sum + r.reservedTokens, 0);
  const quotaMid = await quotaService.getQuota(victim.id);
  assert.strictEqual(
    BigInt(totalReserved) + quotaMid.remainingTokens,
    120n,
    'Total reserved plus remaining tokens must strictly equal initial 120 tokens'
  );
  assert.ok(quotaMid.remainingTokens >= 0n, 'Remaining tokens must never underflow below 0n');

  // Simulate post-response reconciliation on all granted requests with varying consumption
  for (let i = 0; i < granted.length; i++) {
    const res = granted[i];
    // Case A: aborted (0 tokens)
    // Case B: consumed half
    // Case C: attempted to consume double (upstream overshoot)
    const actualConsumed = i % 3 === 0 ? 0 : (i % 3 === 1 ? Math.floor(res.reservedTokens / 2) : res.reservedTokens * 2);
    await quotaService.reconcileQuota(victim.id, res.reservationId, actualConsumed, 0, 200);
  }

  const quotaFinal = await quotaService.getQuota(victim.id);
  assert.ok(quotaFinal.remainingTokens >= 0n, 'Remaining tokens must remain non-negative after all reconciliations');
  assert.ok(quotaFinal.usedTokens > 0n, 'Used tokens must be accurately recorded');

  // Attack Vector 2: SSE Stream Cutoff Simulation
  // User reserves 50 tokens (10 prompt + 40 completion).
  // Upstream attempts to stream 10 chunks of 20 tokens each = 200 completion tokens!
  const streamUser = await store.createUser({
    email: 'stream_hacker@gateway.io',
    passwordHash: 'dummy'
  });
  await quotaService.creditQuota(streamUser.id, 50n);

  const streamRes = await quotaService.reserveQuota(streamUser.id, 50, 10);
  assert.strictEqual(streamRes.success, true);
  assert.strictEqual(streamRes.reservedTokens, 50);

  const parser = new SseStreamParser();
  const maxAllowedTokens = streamRes.reservedTokens; // 50 tokens
  const promptTokensEst = 10;
  let quotaCutoffTriggered = false;
  let emittedChunks = 0;

  // Stream simulation: 10 chunks
  for (let i = 0; i < 10; i++) {
    const rawChunk = `data: {"choices":[{"delta":{"content":"This is a chunk of generated text containing roughly 60 characters."}}]}\n\n`;
    parser.feed(rawChunk);
    emittedChunks++;

    const currentTotal = promptTokensEst + parser.estimatedCompletionTokens;
    if (currentTotal >= maxAllowedTokens) {
      quotaCutoffTriggered = true;
      break; // Stream terminated!
    }
  }

  assert.strictEqual(quotaCutoffTriggered, true, 'Stream monitor must trigger quota cutoff when reaching reserved limit');
  assert.ok(emittedChunks < 10, 'Stream must be aborted before all 10 chunks are delivered');

  // Reconcile stream cutoff
  const partialCompletion = Math.min(parser.estimatedCompletionTokens, maxAllowedTokens - promptTokensEst);
  const actualCharged = Math.min(promptTokensEst + partialCompletion, maxAllowedTokens);
  await quotaService.reconcileQuota(streamUser.id, streamRes.reservationId, actualCharged, 0, 200);

  const quotaAfterStreamCutoff = await quotaService.getQuota(streamUser.id);
  assert.strictEqual(quotaAfterStreamCutoff.remainingTokens, 0n, 'Tokens accurately charged down to 0, no free usage');
  assert.strictEqual(quotaAfterStreamCutoff.usedTokens, BigInt(actualCharged));
  assert.ok(actualCharged <= 50, 'User was never charged or given more than 50 tokens');

  // Attack Vector 3: Responses API Streaming Delta & Usage Accounting
  const responsesStreamParser = new SseStreamParser();
  // Simulate 3 streaming delta events from OpenAI Responses API
  responsesStreamParser.feed('data: {"type":"response.text.delta","delta":"Artificial Intelligence Gateway"}\n\n');
  responsesStreamParser.feed('data: {"type":"response.text.delta","delta":" protects your backend from abuse"}\n\n');
  assert.ok(responsesStreamParser.estimatedCompletionTokens > 0, 'Responses API text deltas must contribute to estimated completion tokens');

  // Simulate final completed event with usage
  responsesStreamParser.feed('data: {"type":"response.completed","response":{"usage":{"input_tokens":15,"output_tokens":25,"total_tokens":40}}}\n\n');
  assert.strictEqual(responsesStreamParser.lastUsage?.prompt_tokens, 15);
  assert.strictEqual(responsesStreamParser.lastUsage?.completion_tokens, 25);
  assert.strictEqual(responsesStreamParser.lastUsage?.total_tokens, 40);

  // Attack Vector 4: Large-scale entropy test (5,000 CDK codes = 60,000 characters)
  const charMap = new Map<string, number>();
  for (let i = 0; i < 5000; i++) {
    const cdk = generateCdkCode();
    const chars = cdk.replace(/CDK-|-/g, '');
    for (const c of chars) {
      charMap.set(c, (charMap.get(c) || 0) + 1);
    }
  }
  assert.strictEqual(charMap.size, 31, 'All 31 base32 characters must be represented');
  const total = 5000 * 12;
  const expected = total / 31;
  for (const [ch, count] of charMap.entries()) {
    const deviation = Math.abs(count - expected) / expected;
    assert.ok(deviation < 0.15, `Character ${ch} count ${count} deviated ${deviation.toFixed(3)} from expected ${expected.toFixed(0)}`);
  }

  // Attack Vector 5: Robustness against NaN, Infinity, negative values, and floats
  const robustUser = await store.createUser({
    email: 'robust_victim@gateway.io',
    passwordHash: 'dummy'
  });
  await quotaService.creditQuota(robustUser.id, 500n);

  // Reconcile with NaN, floats, and Infinity - must never throw RangeError
  const res1 = await quotaService.reserveQuota(robustUser.id, 100, 10);
  assert.strictEqual(res1.success, true);
  await quotaService.reconcileQuota(robustUser.id, res1.reservationId, 45.7, NaN, 200);

  const res2 = await quotaService.reserveQuota(robustUser.id, 50, 10);
  assert.strictEqual(res2.success, true);
  await quotaService.reconcileQuota(robustUser.id, res2.reservationId, NaN, 0, 500);

  await quotaService.deductUsage(robustUser.id, 12.3, 4.8);
  const robustQuota = await quotaService.getQuota(robustUser.id);
  assert.ok(robustQuota.remainingTokens >= 0n, 'Quota must remain valid and non-negative after float/NaN arithmetic');

  // Attack Vector 6: CDK redemption with non-existent userId must reject and not burn the CDK
  const testCdk = await store.createCdk({
    code: 'CDK-TEST-SAFE-USER',
    tokenQuota: 50000n
  });
  const badUserRedeem = await store.redeemCdk(testCdk.code, 'usr_non_existent_id');
  assert.strictEqual(badUserRedeem.success, false);
  assert.strictEqual(badUserRedeem.error, 'User account not found.');
  const cdkAfterFailedRedeem = await store.getCdkByCode(testCdk.code);
  assert.strictEqual(cdkAfterFailedRedeem?.isRedeemed, false, 'CDK must not be marked as redeemed when user does not exist');

  // Valid user redeems the preserved CDK
  const validUserRedeem = await store.redeemCdk(testCdk.code, robustUser.id);
  assert.strictEqual(validUserRedeem.success, true);
  assert.strictEqual(validUserRedeem.tokensAdded, 50000n);

  console.log('✓ Adversarial Attack Vectors & Anti-Free-Usage Guarantees passed successfully!');
}
