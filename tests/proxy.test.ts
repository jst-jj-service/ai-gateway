import assert from 'assert';
import { buildServer } from '../src/server';
import { MemoryStore } from '../src/db/store';
import { config } from '../src/config';

export async function runProxyIntegrationTests() {
  console.log('▶ Testing Fastify API Server & Integration Endpoints...');

  const store = new MemoryStore();
  const app = await buildServer({ store, logger: false });

  // 1. Health check
  const healthRes = await app.inject({
    method: 'GET',
    url: '/health'
  });
  assert.strictEqual(healthRes.statusCode, 200);
  const healthJson = JSON.parse(healthRes.body);
  assert.strictEqual(healthJson.status, 'ok');

  // 2. Register new member
  const regRes = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: 'member@gateway.io',
      password: 'MemberPassword123!',
      name: 'Alice Developer'
    }
  });
  assert.strictEqual(regRes.statusCode, 201);
  const regJson = JSON.parse(regRes.body);
  const userToken = regJson.token;
  const userId = regJson.user.id;
  assert.ok(userToken);

  // 3. Create API Key for member
  const keyRes = await app.inject({
    method: 'POST',
    url: '/api/auth/keys',
    headers: { Authorization: `Bearer ${userToken}` },
    payload: { name: 'My Test Bot' }
  });
  assert.strictEqual(keyRes.statusCode, 201);
  const keyJson = JSON.parse(keyRes.body);
  const userRawApiKey = keyJson.rawKey;
  assert.ok(userRawApiKey.startsWith('sk-gw-'));

  // 4. Test /v1/chat/completions without auth -> Expect 401
  const unauthRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }]
    }
  });
  assert.strictEqual(unauthRes.statusCode, 401);

  // 5. Test /v1/chat/completions with API key but ZERO quota -> Expect 402 with sanitized message & shop link
  const zeroQuotaRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${userRawApiKey}` },
    payload: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Tell me a joke' }]
    }
  });
  assert.strictEqual(zeroQuotaRes.statusCode, 402);
  const zeroQuotaJson = JSON.parse(zeroQuotaRes.body);
  assert.strictEqual(zeroQuotaJson.error.code, 'insufficient_quota');
  assert.ok(zeroQuotaJson.error.suggestion.includes(config.NEXT_PUBLIC_SHOP_URL));

  // 6. Admin login to generate CDK
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

  // 7. Admin generates 1M token CDK
  const genRes = await app.inject({
    method: 'POST',
    url: '/api/cdk/admin/generate',
    headers: { Authorization: `Bearer ${adminToken}` },
    payload: {
      count: 1,
      tokenQuota: 1_000_000,
      tier: 'Starter 1M'
    }
  });
  assert.strictEqual(genRes.statusCode, 201);
  const genJson = JSON.parse(genRes.body);
  const generatedCdk = genJson.cdks[0].code;
  assert.ok(generatedCdk.startsWith('CDK-'));

  // 8. User redeems CDK via /api/cdk/redeem
  const redeemRes = await app.inject({
    method: 'POST',
    url: '/api/cdk/redeem',
    headers: { Authorization: `Bearer ${userToken}` },
    payload: { code: generatedCdk }
  });
  assert.strictEqual(redeemRes.statusCode, 200);
  const redeemJson = JSON.parse(redeemRes.body);
  assert.strictEqual(redeemJson.success, true);
  assert.strictEqual(redeemJson.tokensAdded, 1_000_000);
  assert.strictEqual(redeemJson.quota.remainingTokens, 1_000_000);

  // 9. Dashboard check
  const dashRes = await app.inject({
    method: 'GET',
    url: '/api/usage/dashboard',
    headers: { Authorization: `Bearer ${userToken}` }
  });
  assert.strictEqual(dashRes.statusCode, 200);
  const dashJson = JSON.parse(dashRes.body);
  assert.strictEqual(dashJson.summary.totalTokens, 1_000_000);
  assert.strictEqual(dashJson.summary.remainingTokens, 1_000_000);
  assert.strictEqual(dashJson.summary.totalTokensFormatted, '1.00M');

  // 10. Non-admin user tries to access admin generate -> Expect 403 Forbidden
  const forbiddenRes = await app.inject({
    method: 'POST',
    url: '/api/cdk/admin/generate',
    headers: { Authorization: `Bearer ${userToken}` },
    payload: { count: 1, tokenQuota: 1_000_000 }
  });
  assert.strictEqual(forbiddenRes.statusCode, 403);
  const forbiddenJson = JSON.parse(forbiddenRes.body);
  assert.strictEqual(forbiddenJson.error.code, 'forbidden');

  // 11. Malformed CDK redemption -> Expect 400 Bad Request
  const badCdkRes = await app.inject({
    method: 'POST',
    url: '/api/cdk/redeem',
    headers: { Authorization: `Bearer ${userToken}` },
    payload: { code: 'INVALID-CDK-FORMAT' }
  });
  assert.strictEqual(badCdkRes.statusCode, 400);

  // 12. Admin exports CDKs as CSV -> Expect 200 text/csv
  const csvRes = await app.inject({
    method: 'GET',
    url: '/api/cdk/admin/export',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(csvRes.statusCode, 200);
  assert.strictEqual(csvRes.headers['content-type'], 'text/csv');
  assert.ok(csvRes.body.includes('Code,Quota,QuotaFormatted'));

  // 13. Models endpoint with API Key -> Expect 200 list
  const modelsRes = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: { Authorization: `Bearer ${userRawApiKey}` }
  });
  assert.strictEqual(modelsRes.statusCode, 200);
  const modelsJson = JSON.parse(modelsRes.body);
  assert.strictEqual(modelsJson.object, 'list');
  assert.ok(modelsJson.data.length > 0);

  // 14. Verify API keys cannot access admin control plane endpoints -> Expect 403
  const apiKeyAdminRes = await app.inject({
    method: 'POST',
    url: '/api/cdk/admin/generate',
    headers: { Authorization: `Bearer ${userRawApiKey}` },
    payload: { count: 1, tokenQuota: 1000 }
  });
  assert.strictEqual(apiKeyAdminRes.statusCode, 403);
  const apiKeyAdminJson = JSON.parse(apiKeyAdminRes.body);
  assert.strictEqual(apiKeyAdminJson.error.code, 'forbidden');

  // 15. Test /v1/responses without auth -> Expect 401
  const responsesUnauth = await app.inject({
    method: 'POST',
    url: '/v1/responses',
    payload: {
      model: 'gpt-4o',
      input: 'Test input'
    }
  });
  assert.strictEqual(responsesUnauth.statusCode, 401);

  // 16. Test /v1/responses with zero quota user -> Expect 402 with shop link
  const zeroQuotaUserRes = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: 'zero_quota_user@gateway.io',
      password: 'Password123!',
      name: 'Zero Quota'
    }
  });
  const zeroQuotaToken = JSON.parse(zeroQuotaUserRes.body).token;
  const zeroQuotaResponses = await app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: { Authorization: `Bearer ${zeroQuotaToken}` },
    payload: {
      model: 'gpt-4o',
      input: 'Tell me something'
    }
  });
  assert.strictEqual(zeroQuotaResponses.statusCode, 402);
  const zeroResponsesJson = JSON.parse(zeroQuotaResponses.body);
  assert.strictEqual(zeroResponsesJson.error.code, 'insufficient_quota');
  assert.ok(zeroResponsesJson.error.suggestion.includes(config.NEXT_PUBLIC_SHOP_URL));

  // 17. Test /v1/responses error sanitization (network failure upstream)
  const responsesErr = await app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: { Authorization: `Bearer ${userToken}` },
    payload: {
      model: 'gpt-4o',
      input: 'Test input'
    }
  });
  // Upstream is not running or lacks key during test, so expect sanitized 502/504
  assert.ok(responsesErr.statusCode === 502 || responsesErr.statusCode === 504);
  const responsesErrJson = JSON.parse(responsesErr.body);
  assert.ok(responsesErrJson.error);
  assert.strictEqual(responsesErr.body.includes('api.hzapi.vip'), false, 'Never leak upstream URL in /v1/responses error');
  assert.strictEqual(responsesErr.body.includes('sk-'), false, 'Never leak upstream key in /v1/responses error');

  // 18. Test missing messages array in /v1/chat/completions -> Expect 400 Bad Request
  const badChatPayload = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${userToken}` },
    payload: { model: 'gpt-4o' } // missing messages
  });
  assert.strictEqual(badChatPayload.statusCode, 400);
  const badChatJson = JSON.parse(badChatPayload.body);
  assert.strictEqual(badChatJson.error.code, 'missing_messages');

  // 19. Test missing input/prompt in /v1/responses -> Expect 400 Bad Request
  const badResponsesPayload = await app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: { Authorization: `Bearer ${userToken}` },
    payload: { model: 'gpt-4o' } // missing input/prompt
  });
  assert.strictEqual(badResponsesPayload.statusCode, 400);
  const badResponsesJson = JSON.parse(badResponsesPayload.body);
  assert.strictEqual(badResponsesJson.error.code, 'missing_input');

  // 20. Test Rate Limiting on /api/auth/login (Brute force protection)
  let rateLimitedLogin = false;
  for (let i = 0; i < 15; i++) {
    const loginAttempt = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@gateway.local', password: 'WrongPasswordAttempt!' }
    });
    if (loginAttempt.statusCode === 429) {
      rateLimitedLogin = true;
      break;
    }
  }
  assert.strictEqual(rateLimitedLogin, true, 'Login endpoint must trigger 429 after rapid failed attempts');

  // 21. Test Rate Limiting on /api/cdk/redeem (Dictionary attack protection)
  let rateLimitedRedeem = false;
  for (let i = 0; i < 20; i++) {
    const redeemAttempt = await app.inject({
      method: 'POST',
      url: '/api/cdk/redeem',
      headers: { Authorization: `Bearer ${userToken}` },
      payload: { code: 'CDK-2345-6789-9999' }
    });
    if (redeemAttempt.statusCode === 429) {
      rateLimitedRedeem = true;
      break;
    }
  }
  assert.strictEqual(rateLimitedRedeem, true, 'CDK redemption endpoint must trigger 429 under high frequency');

  // 22. Test Deactivated User with valid JWT Session -> Expect 401 Unauthorized
  const testUser = await store.getUserById(userId);
  if (testUser) {
    testUser.isActive = false;
  }
  const deactivatedRes = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { Authorization: `Bearer ${userToken}` }
  });
  assert.strictEqual(deactivatedRes.statusCode, 401, 'Deactivated account must be rejected even with a valid JWT signature');
  if (testUser) {
    testUser.isActive = true; // restore
  }

  // 23. Test invalid max_tokens parameter in /v1/chat/completions -> Expect 400 Bad Request
  const badMaxTokensRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${userRawApiKey}` },
    payload: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: -10
    }
  });
  assert.strictEqual(badMaxTokensRes.statusCode, 400);
  const badMaxJson = JSON.parse(badMaxTokensRes.body);
  assert.strictEqual(badMaxJson.error.code, 'invalid_max_tokens');

  // 24. Verify proxy API keys cannot manage/create API keys -> Expect 403 Forbidden
  const keyManageRes = await app.inject({
    method: 'POST',
    url: '/api/auth/keys',
    headers: { Authorization: `Bearer ${userRawApiKey}` },
    payload: { name: 'Escalation Key' }
  });
  assert.strictEqual(keyManageRes.statusCode, 403, 'Proxy API keys must not be allowed to create API keys');

  // 25. Enforce 20 API key limit per user
  // User already has 1 key. Create 19 more.
  for (let i = 2; i <= 20; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/keys',
      headers: { Authorization: `Bearer ${userToken}` },
      payload: { name: `Key ${i}` }
    });
    assert.strictEqual(res.statusCode, 201);
  }
  // 21st key must be rejected
  const overflowKeyRes = await app.inject({
    method: 'POST',
    url: '/api/auth/keys',
    headers: { Authorization: `Bearer ${userToken}` },
    payload: { name: 'Key 21 Overflow' }
  });
  assert.strictEqual(overflowKeyRes.statusCode, 400, 'Exceeding 20 API keys must be rejected');

  // 26. Test /v1/messages and /messages without auth -> Expect 401
  const unauthMessagesRes = await app.inject({
    method: 'POST',
    url: '/v1/messages',
    payload: {
      model: 'claude-3-7-sonnet-20250219',
      messages: [{ role: 'user', content: 'Hello' }]
    }
  });
  assert.strictEqual(unauthMessagesRes.statusCode, 401);

  // 27. Test /v1/messages with x-api-key header and invalid payload (empty messages) -> Expect 400
  const invalidMessagesRes = await app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { 'x-api-key': userRawApiKey },
    payload: {
      model: 'claude-3-7-sonnet-20250219',
      messages: []
    }
  });
  assert.strictEqual(invalidMessagesRes.statusCode, 400);

  // 28. Test /v1/models returns complete model catalog across all 6 pools
  const modelsRes = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: { Authorization: `Bearer ${userRawApiKey}` }
  });
  assert.strictEqual(modelsRes.statusCode, 200);
  const modelsJson = JSON.parse(modelsRes.body);
  assert.ok(Array.isArray(modelsJson.data));
  const modelIds = modelsJson.data.map((m: any) => m.id);
  assert.ok(modelIds.includes('gpt-6-astra'));
  assert.ok(modelIds.includes('gpt-5.6-sol'));
  assert.ok(modelIds.includes('claude-3-7-sonnet-20250219'));
  assert.ok(modelIds.includes('claude-opus-5'));

  await app.close();
  console.log('✓ Fastify Integration, /v1/responses & /v1/messages tests passed successfully!');
}
