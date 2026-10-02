import { runErrorSanitizerTests } from './error-sanitizer.test';
import { runCdkTests } from './cdk.test';
import { runQuotaAndUsageTests } from './quota-and-usage.test';
import { runAuthTests } from './auth.test';
import { runProxyIntegrationTests } from './proxy.test';
import { runPersistenceTests } from './persistence.test';
import { runAdversarialQuotaTests } from './adversarial-quota.test';
import { runUpstreamRoutingTests } from './upstream-routing.test';
import { runAdminRoutesTests } from './admin-routes.test';
import { runStaticServingTests } from './static-serving.test';

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING AI GATEWAY VERIFICATION TEST SUITE');
  console.log('====================================================\n');

  const startTime = Date.now();
  let passed = 0;
  let failed = 0;

  const suites = [
    { name: 'Error Sanitizer & Leak Prevention', fn: runErrorSanitizerTests },
    { name: 'CDK Generation & Redemption', fn: runCdkTests },
    { name: 'Quota Accounting & Formatting', fn: runQuotaAndUsageTests },
    { name: 'Authentication & API Key Management', fn: runAuthTests },
    { name: 'Fastify Server & Proxy Integration', fn: runProxyIntegrationTests },
    { name: 'JSON File Persistence & Data Recovery', fn: runPersistenceTests },
    { name: 'Adversarial Attacks & Anti-Free-Usage Guarantees', fn: runAdversarialQuotaTests },
    { name: 'Multi-Key Intelligent Model Routing', fn: runUpstreamRoutingTests },
    { name: 'Admin User Management & System Stats', fn: runAdminRoutesTests },
    { name: 'Web Dashboard & Client Portal Serving', fn: runStaticServingTests }
  ];

  for (const suite of suites) {
    try {
      await suite.fn();
      passed++;
      console.log(`[PASS] ${suite.name}\n`);
    } catch (err: any) {
      failed++;
      console.error(`[FAIL] ${suite.name}`);
      console.error(err);
      console.log('\n');
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('====================================================');
  console.log(`TEST SUMMARY: ${passed} passed, ${failed} failed (${duration}s)`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
