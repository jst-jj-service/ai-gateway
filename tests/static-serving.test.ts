import assert from 'assert';
import { buildServer } from '../src/server';
import { MemoryStore } from '../src/db/store';

export async function runStaticServingTests() {
  console.log('▶ Testing Public Web Dashboard & Client Portal Serving...');

  const store = new MemoryStore();
  const app = await buildServer({ store, logger: false });

  // 1. Root index.html serving (Home portal)
  const homeRes = await app.inject({
    method: 'GET',
    url: '/'
  });
  assert.strictEqual(homeRes.statusCode, 200, 'Root should serve HTTP 200');
  assert.ok(
    homeRes.headers['content-type']?.includes('text/html'),
    'Root content type should be text/html'
  );
  assert.ok(
    homeRes.body.includes('<!DOCTYPE html>') || homeRes.body.includes('html'),
    'Root should contain HTML body'
  );

  // 2. Login page
  const loginRes = await app.inject({
    method: 'GET',
    url: '/login/'
  });
  assert.strictEqual(loginRes.statusCode, 200, 'Login page should serve HTTP 200');
  assert.ok(
    loginRes.headers['content-type']?.includes('text/html'),
    'Login page should be text/html'
  );

  // 3. Register page
  const registerRes = await app.inject({
    method: 'GET',
    url: '/register/'
  });
  assert.strictEqual(registerRes.statusCode, 200, 'Register page should serve HTTP 200');

  // 4. Dashboard page
  const dashboardRes = await app.inject({
    method: 'GET',
    url: '/dashboard/'
  });
  assert.strictEqual(dashboardRes.statusCode, 200, 'Dashboard page should serve HTTP 200');

  // 5. Payment & Redeem page
  const paymentRes = await app.inject({
    method: 'GET',
    url: '/dashboard/payment/'
  });
  assert.strictEqual(paymentRes.statusCode, 200, 'Payment page should serve HTTP 200');

  // 6. API routes must NEVER return HTML on 404 - must return JSON error
  const apiNotFoundRes = await app.inject({
    method: 'GET',
    url: '/api/not-a-real-endpoint'
  });
  assert.strictEqual(apiNotFoundRes.statusCode, 404);
  assert.ok(
    apiNotFoundRes.headers['content-type']?.includes('application/json'),
    'API 404 must be JSON'
  );
  const apiJson = JSON.parse(apiNotFoundRes.body);
  assert.ok(apiJson.error, 'API 404 must contain error object');

  // 7. Health endpoint remains functional
  const healthRes = await app.inject({
    method: 'GET',
    url: '/health'
  });
  assert.strictEqual(healthRes.statusCode, 200);
  assert.strictEqual(JSON.parse(healthRes.body).status, 'ok');

  await app.close();
  console.log('✓ Public Web Dashboard & Client Portal Serving tests passed successfully!');
}

if (require.main === module) {
  runStaticServingTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
