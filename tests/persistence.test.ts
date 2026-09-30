import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { MemoryStore } from '../src/db/store';

export async function runPersistenceTests() {
  console.log('▶ Testing JSON File Persistence & Store Reloading...');

  const tmpDir = path.join(__dirname, '../data');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const tmpFile = path.join(tmpDir, `test-persist-${Date.now()}.json`);

  try {
    // 1. Initialize store with persistence path
    const store1 = new MemoryStore(tmpFile);

    // Create user
    const user = await store1.createUser({
      email: 'persist_user@gateway.io',
      passwordHash: 'hash_abc_123',
      name: 'Persist Tester',
      role: 'USER'
    });

    // Create API Key
    const apiKey = await store1.createApiKey({
      userId: user.id,
      keyHash: 'fake_hash_999',
      keyPrefix: 'sk-gw-test...',
      name: 'Persist Key'
    });

    // Create CDK
    const cdk = await store1.createCdk({
      code: 'CDK-TEST-PERS-1234',
      tokenQuota: 5_000_000n,
      tier: 'Pro Tier'
    });

    // Redeem CDK
    const redeemResult = await store1.redeemCdk(cdk.code, user.id);
    assert.strictEqual(redeemResult.success, true);
    assert.strictEqual(redeemResult.tokensAdded, 5_000_000n);

    // Record usage
    await store1.recordUsage({
      userId: user.id,
      apiKeyId: apiKey.id,
      model: 'gpt-4o',
      promptTokens: 1000,
      completionTokens: 500,
      cachedTokens: 200,
      totalTokens: 1500,
      requestDurationMs: 300,
      statusCode: 200,
      isStream: false
    });

    // Deduct usage
    await store1.deductTokensFromQuota(user.id, 1500, 200);

    // Flush to file
    store1.saveToFile();
    assert.ok(fs.existsSync(tmpFile), 'Persist file should exist on disk');

    // 2. Instantiate a second, completely separate store instance loading from the same file
    const store2 = new MemoryStore(tmpFile);

    // Verify User loaded correctly
    const loadedUser = await store2.getUserByEmail('persist_user@gateway.io');
    assert.ok(loadedUser, 'User should be loaded from disk');
    assert.strictEqual(loadedUser?.id, user.id);
    assert.strictEqual(loadedUser?.name, 'Persist Tester');

    // Verify API key loaded correctly
    const loadedKey = await store2.getApiKeyByHash('fake_hash_999');
    assert.ok(loadedKey, 'API key should be loaded from disk');
    assert.strictEqual(loadedKey?.id, apiKey.id);

    // Verify CDK loaded with correct BigInt and redeemed state
    const loadedCdk = await store2.getCdkByCode('CDK-TEST-PERS-1234');
    assert.ok(loadedCdk, 'CDK should be loaded from disk');
    assert.strictEqual(loadedCdk?.tokenQuota, 5_000_000n);
    assert.strictEqual(loadedCdk?.isRedeemed, true);

    // Verify Quota loaded with BigInt arithmetic intact
    const loadedQuota = await store2.getUserQuota(user.id);
    assert.strictEqual(loadedQuota.totalTokens, 5_000_000n);
    assert.strictEqual(loadedQuota.usedTokens, 1500n);
    assert.strictEqual(loadedQuota.cachedTokens, 200n);
    assert.strictEqual(loadedQuota.remainingTokens, 5_000_000n - 1500n);

    // Verify Usage summary loaded
    const summary = await store2.getUserUsageSummary(user.id);
    assert.strictEqual(summary.totalTokens, 5_000_000);
    assert.strictEqual(summary.usedTokens, 1500);
    assert.strictEqual(summary.cachedTokens, 200);
    assert.strictEqual(summary.promptTokens, 1000);
    assert.strictEqual(summary.completionTokens, 500);
    assert.strictEqual(summary.requestCount, 1);

    // 3. Test Atomic Backup Creation and Corruption Auto-Recovery
    store2.saveToFile();
    const backupFile = `${tmpFile}.bak`;
    assert.ok(fs.existsSync(backupFile), 'Backup file .bak must be created on save');

    // Simulate primary file corruption
    fs.writeFileSync(tmpFile, 'CORRUPTED_GARBAGE_DATA{{{', 'utf-8');

    // A third store should detect corruption in primary and recover seamlessly from backup
    const store3 = new MemoryStore(tmpFile);
    const recoveredUser = await store3.getUserByEmail('persist_user@gateway.io');
    assert.ok(recoveredUser, 'Should recover user from backup file when primary is corrupted');
    assert.strictEqual(recoveredUser?.id, user.id);

    // 4. Test Zero-byte primary protection: backup must NOT be overwritten by empty primary
    const backupContentBefore = fs.readFileSync(backupFile, 'utf-8');
    assert.ok(backupContentBefore.length > 50, 'Backup file should have healthy content');

    // Make primary 0 bytes
    fs.writeFileSync(tmpFile, '', 'utf-8');
    store3.saveToFile(); // saveToFile should avoid copying 0-byte primary to backup

    const backupContentAfter = fs.readFileSync(backupFile, 'utf-8');
    assert.ok(backupContentAfter.length > 50, 'Backup file must remain intact and not replaced with 0-byte empty file');

    // 5. Test Usage Memory Bounds (DoS / Memory Leak Prevention)
    const storeBounded = new MemoryStore();
    for (let i = 0; i < 1100; i++) {
      await storeBounded.recordUsage({
        userId: user.id,
        model: 'gpt-4o-mini',
        promptTokens: 10,
        completionTokens: 10,
        cachedTokens: 0,
        totalTokens: 20,
        requestDurationMs: 50,
        statusCode: 200,
        isStream: false
      });
    }

    const recentLogs = await storeBounded.getRecentUsageLogs(user.id, 2000);
    assert.ok(recentLogs.length <= MemoryStore.MAX_USER_USAGE_RECORDS, 'User usage records must be capped to prevent memory leaks');

    console.log('✓ JSON File Persistence, Atomic Backup & Bounded Memory tests passed successfully!');
  } finally {
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
    const backupFile = `${tmpFile}.bak`;
    if (fs.existsSync(backupFile)) {
      try { fs.unlinkSync(backupFile); } catch {}
    }
  }
}
