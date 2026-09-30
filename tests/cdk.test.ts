import assert from 'assert';
import { MemoryStore } from '../src/db/store';
import { CdkService } from '../src/services/cdk.service';
import { isValidCdkFormat, generateCdkCode } from '../src/utils/cdk-generator';

export async function runCdkTests() {
  console.log('▶ Testing CDK Activation & Redemption Service...');

  const store = new MemoryStore();
  const cdkService = new CdkService(store);

  // Create a user in store
  const user = await store.createUser({
    email: 'cdkuser@example.com',
    passwordHash: 'hash123'
  });

  // Test 1: Batch CDK Generation
  const cdks = await cdkService.generateBatch({
    count: 5,
    tokenQuota: 2_000_000,
    tier: 'Pro Tier'
  });

  assert.strictEqual(cdks.length, 5);
  for (const cdk of cdks) {
    assert.strictEqual(isValidCdkFormat(cdk.code), true, `Invalid CDK format: ${cdk.code}`);
    assert.strictEqual(cdk.tokenQuota, 2_000_000n);
    assert.strictEqual(cdk.isRedeemed, false);
  }

  // Test 2: Successful Redemption
  const firstCdk = cdks[0];
  const redeemResult = await cdkService.redeem(firstCdk.code, user.id);

  assert.strictEqual(redeemResult.success, true);
  assert.strictEqual(redeemResult.tokensAdded, 2_000_000);
  assert.strictEqual(redeemResult.tokensAddedFormatted, '2.00M');

  // Verify User Quota updated
  const quota = await store.getUserQuota(user.id);
  assert.strictEqual(quota.totalTokens, 2_000_000n);
  assert.strictEqual(quota.remainingTokens, 2_000_000n);

  // Test 3: Duplicate Redemption Rejection
  const duplicateRedeem = await cdkService.redeem(firstCdk.code, user.id);
  assert.strictEqual(duplicateRedeem.success, false);
  assert.strictEqual(duplicateRedeem.error?.includes('already been redeemed'), true);

  // Test 4: Invalid Code Format
  const invalidRedeem = await cdkService.redeem('INVALID-CODE-XYZ', user.id);
  assert.strictEqual(invalidRedeem.success, false);
  assert.strictEqual(invalidRedeem.error?.includes('Invalid CDK format'), true);

  // Test 5: Non-existent Code
  const fakeCode = 'CDK-9999-8888-7777';
  const nonExistentRedeem = await cdkService.redeem(fakeCode, user.id);
  assert.strictEqual(nonExistentRedeem.success, false);

  // Test 6: Expired CDK
  const expiredCdk = await store.createCdk({
    code: 'CDK-AAAA-BBBB-CCCC',
    tokenQuota: 500_000n,
    expiresAt: new Date(Date.now() - 1000) // expired 1 sec ago
  });
  const expiredRedeem = await cdkService.redeem(expiredCdk.code, user.id);
  assert.strictEqual(expiredRedeem.success, false);
  assert.strictEqual(expiredRedeem.error?.includes('expired'), true);

  // Test 7: Concurrent double-spend prevention
  const concurrencyCdk = cdks[1];
  const concurrentAttempts = await Promise.all(
    Array.from({ length: 10 }).map(() => cdkService.redeem(concurrencyCdk.code, user.id))
  );

  const successes = concurrentAttempts.filter(r => r.success);
  const failures = concurrentAttempts.filter(r => !r.success);

  assert.strictEqual(successes.length, 1, 'Exactly one concurrent redemption attempt must succeed');
  assert.strictEqual(failures.length, 9, 'All other concurrent redemption attempts must be rejected');

  // Verify quota was credited exactly once for the concurrent CDK
  const quotaAfterConcurrent = await store.getUserQuota(user.id);
  assert.strictEqual(quotaAfterConcurrent.totalTokens, 4_000_000n, 'Total quota must only reflect 2 successful CDKs');

  // Test 8: Modulo Bias Entropy Verification
  const sampleCount = 2000;
  const charFrequencies = new Map<string, number>();
  for (let i = 0; i < sampleCount; i++) {
    const code = generateCdkCode();
    const cleanChars = code.replace(/CDK-|-/g, '');
    for (const ch of cleanChars) {
      charFrequencies.set(ch, (charFrequencies.get(ch) || 0) + 1);
    }
  }

  // All 31 unambiguous characters should appear
  assert.strictEqual(charFrequencies.size, 31, 'All 31 unambiguous characters must be generated');
  const totalChars = sampleCount * 12;
  const expectedPerChar = totalChars / 31;
  for (const [char, count] of charFrequencies.entries()) {
    // Check that every character is within statistical tolerance (no severe modulo bias skew)
    const ratio = count / expectedPerChar;
    assert.ok(ratio > 0.75 && ratio < 1.25, `Character '${char}' frequency (${count}) deviated unusually from expected (${expectedPerChar.toFixed(0)})`);
  }

  console.log('✓ CDK Activation, Concurrency & Entropy tests passed successfully!');
}
