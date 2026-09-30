import { defaultStore } from '../src/db/store';
import { AuthService } from '../src/services/auth.service';
import { CdkService } from '../src/services/cdk.service';
import { config } from '../src/config';

async function seed() {
  console.log('Seeding initial data for AI Gateway...');

  const authService = new AuthService(defaultStore);
  const cdkService = new CdkService(defaultStore);

  // 1. Seed Admin
  const admin = await authService.seedInitialAdmin(
    config.INITIAL_ADMIN_EMAIL,
    config.INITIAL_ADMIN_PASSWORD
  );
  console.log(`✓ Admin user ready: ${admin.email} (Password: ${config.INITIAL_ADMIN_PASSWORD})`);

  // 2. Seed Test User
  const testUserEmail = 'user@example.com';
  const testUserPass = 'UserPass123!';
  let testUser = await defaultStore.getUserByEmail(testUserEmail);
  if (!testUser) {
    testUser = await authService.register({
      email: testUserEmail,
      password: testUserPass,
      name: 'Demo Member'
    });
    console.log(`✓ Demo user created: ${testUser.email} (Password: ${testUserPass})`);
  }

  // 3. Seed Sample CDKs
  const starterCdks = await cdkService.generateBatch({
    count: 3,
    tokenQuota: 1_000_000,
    tier: 'Starter (1M Tokens)'
  });

  const proCdks = await cdkService.generateBatch({
    count: 2,
    tokenQuota: 5_000_000,
    tier: 'Pro (5M Tokens)'
  });

  const enterpriseCdk = await cdkService.generateBatch({
    count: 1,
    tokenQuota: 20_000_000,
    tier: 'Enterprise (20M Tokens)'
  });

  console.log('\n--- Generated Sample CDKs (Ready to Redeem) ---');
  starterCdks.forEach(c => console.log(`[Starter 1M]    Code: ${c.code}`));
  proCdks.forEach(c => console.log(`[Pro 5M]        Code: ${c.code}`));
  enterpriseCdk.forEach(c => console.log(`[Enterprise 20M] Code: ${c.code}`));
  console.log('-----------------------------------------------\n');

  defaultStore.saveToFile();
  console.log('✓ Store data successfully persisted to disk.');
}

seed().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
