import assert from 'assert';
import { buildServer } from '../src/server';
import { MemoryStore } from '../src/db/store';
import { config } from '../src/config';

async function testFullAccountFlow() {
  console.log('====================================================');
  console.log('🚀 TESTING COMPLETE USER ACCOUNT SYSTEM FLOW');
  console.log('====================================================\n');

  const store = new MemoryStore();
  const app = await buildServer({ store, logger: false });

  // ----------------------------------------------------
  // STEP 1: User Registration
  // ----------------------------------------------------
  console.log('1. Testing User Registration (POST /api/auth/register)...');
  const regRes = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: 'customer@test.com',
      password: 'StrongCustomerPassword2026!',
      name: 'Alice Customer'
    }
  });

  assert.strictEqual(regRes.statusCode, 201, 'Registration should return 201 Created');
  const regData = JSON.parse(regRes.body);
  assert.ok(regData.token, 'Should return JWT auth token');
  assert.strictEqual(regData.user.email, 'customer@test.com');
  assert.strictEqual(regData.user.name, 'Alice Customer');
  assert.strictEqual(regData.user.role, 'USER');
  const customerToken = regData.token;
  const customerId = regData.user.id;
  console.log('   ✓ User registered successfully! User ID:', customerId);

  // ----------------------------------------------------
  // STEP 2: Duplicate Registration Prevention
  // ----------------------------------------------------
  console.log('\n2. Testing Duplicate Registration Prevention...');
  const dupRes = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: 'customer@test.com',
      password: 'AnotherPassword!'
    }
  });
  assert.strictEqual(dupRes.statusCode, 400, 'Duplicate registration should be rejected');
  console.log('   ✓ Duplicate email correctly rejected with HTTP 400.');

  // ----------------------------------------------------
  // STEP 3: User Login
  // ----------------------------------------------------
  console.log('\n3. Testing User Login (POST /api/auth/login)...');
  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      email: 'customer@test.com',
      password: 'StrongCustomerPassword2026!'
    }
  });
  assert.strictEqual(loginRes.statusCode, 200, 'Login should return 200 OK');
  const loginData = JSON.parse(loginRes.body);
  assert.ok(loginData.token, 'Login should return fresh JWT');
  console.log('   ✓ User logged in successfully! JWT received.');

  // ----------------------------------------------------
  // STEP 4: Initial Balance Check (Should be 0)
  // ----------------------------------------------------
  console.log('\n4. Checking Initial Balance (GET /api/auth/me)...');
  const meRes = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  assert.strictEqual(meRes.statusCode, 200);
  const meData = JSON.parse(meRes.body);
  assert.strictEqual(meData.quota.remainingTokens, 0);
  console.log('   ✓ Initial token balance verified: 0 tokens (Formatted:', meData.quota.remainingTokensFormatted, ')');

  // ----------------------------------------------------
  // STEP 5: Admin Login & Batch CDK Generation
  // ----------------------------------------------------
  console.log('\n5. Admin Login & CDK Batch Generation (POST /api/cdk/admin/generate)...');
  const adminLoginRes = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      email: config.INITIAL_ADMIN_EMAIL,
      password: config.INITIAL_ADMIN_PASSWORD
    }
  });
  assert.strictEqual(adminLoginRes.statusCode, 200);
  const adminToken = JSON.parse(adminLoginRes.body).token;

  const genCdkRes = await app.inject({
    method: 'POST',
    url: '/api/cdk/admin/generate',
    headers: { Authorization: `Bearer ${adminToken}` },
    payload: {
      count: 2,
      tokenQuota: 2_000_000,
      tier: 'Pro Tier'
    }
  });
  assert.strictEqual(genCdkRes.statusCode, 201);
  const genCdkData = JSON.parse(genCdkRes.body);
  assert.strictEqual(genCdkData.count, 2);
  const cdkCode1 = genCdkData.cdks[0].code;
  const cdkCode2 = genCdkData.cdks[1].code;
  console.log('   ✓ Generated 2 CDKs (2.00M tokens each). Sample CDK:', cdkCode1);

  // ----------------------------------------------------
  // STEP 6: User Top-up via CDK Self-Redeem
  // ----------------------------------------------------
  console.log('\n6. Testing User Top-Up / Self-Redeem (POST /api/cdk/redeem)...');
  const redeemRes = await app.inject({
    method: 'POST',
    url: '/api/cdk/redeem',
    headers: { Authorization: `Bearer ${customerToken}` },
    payload: { code: cdkCode1 }
  });
  assert.strictEqual(redeemRes.statusCode, 200);
  const redeemData = JSON.parse(redeemRes.body);
  assert.strictEqual(redeemData.success, true);
  assert.strictEqual(redeemData.tokensAdded, 2_000_000);
  assert.strictEqual(redeemData.quota.remainingTokens, 2_000_000);
  console.log('   ✓ CDK redeemed successfully! Balance is now:', redeemData.quota.remainingTokensFormatted);

  // ----------------------------------------------------
  // STEP 7: Double-Spend Prevention on CDK
  // ----------------------------------------------------
  console.log('\n7. Testing CDK Anti-Double-Spend Protection...');
  const doubleRedeemRes = await app.inject({
    method: 'POST',
    url: '/api/cdk/redeem',
    headers: { Authorization: `Bearer ${customerToken}` },
    payload: { code: cdkCode1 }
  });
  assert.strictEqual(doubleRedeemRes.statusCode, 400);
  console.log('   ✓ Second redemption attempt rejected! (Already redeemed error).');

  // ----------------------------------------------------
  // STEP 8: Create User API Key
  // ----------------------------------------------------
  console.log('\n8. Testing API Key Generation (POST /api/auth/keys)...');
  const createKeyRes = await app.inject({
    method: 'POST',
    url: '/api/auth/keys',
    headers: { Authorization: `Bearer ${customerToken}` },
    payload: { name: 'Cursor IDE Key' }
  });
  assert.strictEqual(createKeyRes.statusCode, 201);
  const keyData = JSON.parse(createKeyRes.body);
  assert.ok(keyData.rawKey.startsWith('sk-gw-'), 'Raw key must have sk-gw- prefix');
  assert.strictEqual(keyData.apiKey.name, 'Cursor IDE Key');
  console.log('   ✓ API key generated:', keyData.rawKey);

  // List API keys
  const listKeysRes = await app.inject({
    method: 'GET',
    url: '/api/auth/keys',
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  assert.strictEqual(listKeysRes.statusCode, 200);
  const listData = JSON.parse(listKeysRes.body);
  assert.strictEqual(listData.keys.length, 1);
  assert.strictEqual(listData.keys[0].name, 'Cursor IDE Key');
  console.log('   ✓ API keys listed successfully.');

  // ----------------------------------------------------
  // STEP 9: Admin Manual Credit Top-Up
  // ----------------------------------------------------
  console.log('\n9. Testing Admin Manual Credit Top-Up (POST /api/admin/users/:id/credits)...');
  const adminCreditRes = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${customerId}/credits`,
    headers: { Authorization: `Bearer ${adminToken}` },
    payload: { tokens: 500_000 }
  });
  assert.strictEqual(adminCreditRes.statusCode, 200);
  const adminCreditData = JSON.parse(adminCreditRes.body);
  assert.strictEqual(adminCreditData.success, true);
  assert.strictEqual(adminCreditData.quota.remainingTokens, 2_500_000);
  console.log('   ✓ Admin manually added 500,000 tokens! New user balance: 2.50M tokens');

  // ----------------------------------------------------
  // STEP 10: User Final Profile Verification
  // ----------------------------------------------------
  console.log('\n10. Verifying Final User Profile State (GET /api/auth/me)...');
  const finalMeRes = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  assert.strictEqual(finalMeRes.statusCode, 200);
  const finalMe = JSON.parse(finalMeRes.body);
  assert.strictEqual(finalMe.quota.remainingTokens, 2_500_000);
  assert.strictEqual(finalMe.quota.remainingTokensFormatted, '2.50M');
  console.log('   ✓ Verified: User balance is 2.50M tokens with active API keys ready for requests.');

  console.log('\n====================================================');
  console.log('✅ ALL USER ACCOUNT SYSTEM FLOWS VERIFIED 100% READY');
  console.log('====================================================');
}

testFullAccountFlow().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
