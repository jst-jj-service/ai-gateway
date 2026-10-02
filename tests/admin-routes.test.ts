import assert from 'assert';
import { buildServer } from '../src/server';
import { MemoryStore } from '../src/db/store';
import { config } from '../src/config';

export async function runAdminRoutesTests() {
  console.log('▶ Testing Admin User Management & System Stats Endpoints...');

  const store = new MemoryStore();
  const app = await buildServer({ store, logger: false });

  // 1. Admin login
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
  const adminUser = JSON.parse(adminLoginRes.body).user;

  // 2. Register regular user
  const userRegRes = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: 'bob@tester.com',
      password: 'BobSecurePassword123!',
      name: 'Bob Tester'
    }
  });
  assert.strictEqual(userRegRes.statusCode, 201);
  const userToken = JSON.parse(userRegRes.body).token;
  const bobId = JSON.parse(userRegRes.body).user.id;

  // 3. Regular user attempting to access admin endpoints -> expect 403
  const forbiddenRes = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: { Authorization: `Bearer ${userToken}` }
  });
  assert.strictEqual(forbiddenRes.statusCode, 403);

  // 4. Admin accesses GET /api/admin/stats
  const statsRes = await app.inject({
    method: 'GET',
    url: '/api/admin/stats',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(statsRes.statusCode, 200);
  const stats = JSON.parse(statsRes.body);
  assert.strictEqual(stats.totalUsers, 2); // admin + bob
  assert.strictEqual(stats.activeUsers, 2);
  assert.ok(stats.totalTokensRedeemedFormatted);

  // 5. Admin accesses GET /api/admin/users
  const usersRes = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(usersRes.statusCode, 200);
  const usersData = JSON.parse(usersRes.body);
  assert.strictEqual(usersData.total, 2);
  assert.ok(Array.isArray(usersData.users));

  // 6. Admin searches users with query
  const searchRes = await app.inject({
    method: 'GET',
    url: '/api/admin/users?search=bob',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(searchRes.statusCode, 200);
  const searchData = JSON.parse(searchRes.body);
  assert.strictEqual(searchData.total, 1);
  assert.strictEqual(searchData.users[0].email, 'bob@tester.com');

  // 7. Admin gets single user details GET /api/admin/users/:id
  const detailRes = await app.inject({
    method: 'GET',
    url: `/api/admin/users/${bobId}`,
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(detailRes.statusCode, 200);
  const detailData = JSON.parse(detailRes.body);
  assert.strictEqual(detailData.user.id, bobId);
  assert.strictEqual(detailData.quota.remainingTokens, 0);

  // 8. Admin manually adds credits POST /api/admin/users/:id/credits
  const creditRes = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${bobId}/credits`,
    headers: { Authorization: `Bearer ${adminToken}` },
    payload: { tokens: 500000 }
  });
  assert.strictEqual(creditRes.statusCode, 200);
  const creditData = JSON.parse(creditRes.body);
  assert.strictEqual(creditData.success, true);
  assert.strictEqual(creditData.tokensAdded, 500000);
  assert.strictEqual(creditData.quota.remainingTokens, 500000);

  // 9. Admin deactivates Bob's account
  const disableRes = await app.inject({
    method: 'PATCH',
    url: `/api/admin/users/${bobId}/status`,
    headers: { Authorization: `Bearer ${adminToken}` },
    payload: { isActive: false }
  });
  assert.strictEqual(disableRes.statusCode, 200);
  const disableData = JSON.parse(disableRes.body);
  assert.strictEqual(disableData.user.isActive, false);

  // Bob tries to login while deactivated -> 401
  const bobDisabledLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      email: 'bob@tester.com',
      password: 'BobSecurePassword123!'
    }
  });
  assert.strictEqual(bobDisabledLogin.statusCode, 401);

  // 10. Admin tries to deactivate themselves -> 400 blocked
  const selfDeactivateRes = await app.inject({
    method: 'PATCH',
    url: `/api/admin/users/${adminUser.id}/status`,
    headers: { Authorization: `Bearer ${adminToken}` },
    payload: { isActive: false }
  });
  assert.strictEqual(selfDeactivateRes.statusCode, 400);

  // 11. Admin reactivates Bob's account
  const reactivateRes = await app.inject({
    method: 'PATCH',
    url: `/api/admin/users/${bobId}/status`,
    headers: { Authorization: `Bearer ${adminToken}` },
    payload: { isActive: true }
  });
  assert.strictEqual(reactivateRes.statusCode, 200);
  assert.strictEqual(JSON.parse(reactivateRes.body).user.isActive, true);

  // 12. Admin resets Bob's password
  const resetPassRes = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${bobId}/reset-password`,
    headers: { Authorization: `Bearer ${adminToken}` },
    payload: { newPassword: 'NewBobSecurePass2026!' }
  });
  assert.strictEqual(resetPassRes.statusCode, 200);
  assert.strictEqual(JSON.parse(resetPassRes.body).success, true);

  // Bob can now log in with the new password
  const bobNewLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      email: 'bob@tester.com',
      password: 'NewBobSecurePass2026!'
    }
  });
  assert.strictEqual(bobNewLogin.statusCode, 200);

  // 13. Admin tries to delete themselves -> 400 blocked
  const selfDeleteRes = await app.inject({
    method: 'DELETE',
    url: `/api/admin/users/${adminUser.id}`,
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(selfDeleteRes.statusCode, 400);

  // 14. Admin deletes Bob's account
  const deleteRes = await app.inject({
    method: 'DELETE',
    url: `/api/admin/users/${bobId}`,
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(deleteRes.statusCode, 200);
  assert.strictEqual(JSON.parse(deleteRes.body).success, true);

  // Verify Bob is gone
  const verifyDeleteRes = await app.inject({
    method: 'GET',
    url: `/api/admin/users/${bobId}`,
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(verifyDeleteRes.statusCode, 404);

  console.log('✓ Admin User Management & Stats tests passed successfully!');
}
