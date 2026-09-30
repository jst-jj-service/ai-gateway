import assert from 'assert';
import { MemoryStore } from '../src/db/store';
import { AuthService } from '../src/services/auth.service';

export async function runAuthTests() {
  console.log('▶ Testing Authentication & API Key Management...');

  const store = new MemoryStore();
  const authService = new AuthService(store);

  // Test 1: Register user
  const user = await authService.register({
    email: 'newuser@domain.com',
    password: 'SecurePassword123!',
    name: 'Test Member'
  });

  assert.ok(user.id);
  assert.strictEqual(user.email, 'newuser@domain.com');
  assert.notStrictEqual(user.passwordHash, 'SecurePassword123!', 'Password must be hashed');

  // Test 2: Reject duplicate registration
  await assert.rejects(
    async () => {
      await authService.register({
        email: 'newuser@domain.com',
        password: 'AnotherPassword'
      });
    },
    /already registered/
  );

  // Test 3: Validate user credentials
  const validUser = await authService.validateUser('newuser@domain.com', 'SecurePassword123!');
  assert.ok(validUser);
  assert.strictEqual(validUser?.id, user.id);

  const invalidUser = await authService.validateUser('newuser@domain.com', 'WrongPassword!');
  assert.strictEqual(invalidUser, null);

  // Test 4: Create API key
  const { apiKey, rawKey } = await authService.createApiKey(user.id, 'Production API Key');
  assert.ok(rawKey.startsWith('sk-gw-'));
  assert.strictEqual(apiKey.userId, user.id);
  assert.strictEqual(apiKey.name, 'Production API Key');

  // Test 5: Authenticate with raw API key
  const authResult = await authService.authenticateApiKey(rawKey);
  assert.ok(authResult);
  assert.strictEqual(authResult?.id, user.id);
  assert.strictEqual(authResult?.apiKeyId, apiKey.id);

  // Test 6: Reject invalid API key
  const badAuth = await authService.authenticateApiKey('sk-gw-invalid-key-that-does-not-exist');
  assert.strictEqual(badAuth, null);

  // Test 7: Seed admin
  const admin = await authService.seedInitialAdmin('admin@root.local', 'AdminMaster999!');
  assert.strictEqual(admin.role, 'ADMIN');

  // Test 8: Deactivated user rejection
  user.isActive = false;
  const activeCheck = await authService.validateSessionUser(user.id);
  assert.strictEqual(activeCheck, null, 'Inactive user must be rejected');
  const apiKeyDeactivatedCheck = await authService.authenticateApiKey(rawKey);
  assert.strictEqual(apiKeyDeactivatedCheck, null, 'API key for inactive user must be rejected');

  // Test 9: Admin re-seeding password sync
  const updatedAdmin = await authService.seedInitialAdmin('admin@root.local', 'NewMasterPassword888!');
  assert.strictEqual(updatedAdmin.role, 'ADMIN');
  const adminLoginSuccess = await authService.validateUser('admin@root.local', 'NewMasterPassword888!');
  assert.ok(adminLoginSuccess, 'Re-seeded admin must authenticate with updated password');
  const oldPassFail = await authService.validateUser('admin@root.local', 'AdminMaster999!');
  assert.strictEqual(oldPassFail, null, 'Old password must no longer work');

  // Test 10: Change password
  user.isActive = true;
  const changeRes = await authService.changePassword(user.id, 'SecurePassword123!', 'BrandNewPass456!');
  assert.strictEqual(changeRes.success, true);
  const recheckUser = await store.getUserById(user.id);
  assert.ok(recheckUser);
  const newPassValid = await authService.validateUser(user.email, 'BrandNewPass456!');
  assert.ok(newPassValid, 'User should authenticate with changed password');

  // Test 11: Wrong current password rejected
  const badChangeRes = await authService.changePassword(user.id, 'WrongCurrentPass!', 'ShouldFail123!');
  assert.strictEqual(badChangeRes.success, false);

  console.log('✓ Authentication & API Key tests passed successfully!');
}
