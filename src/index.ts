import { buildServer } from './server';
import { config } from './config';

async function main() {
  const app = await buildServer({ logger: true });

  try {
    const address = await app.listen({
      port: config.PORT,
      host: config.HOST
    });
    console.log(`=======================================================`);
    console.log(`🚀 AI Gateway Server listening at: ${address}`);
    console.log(`⚡ Upstream AI Gateway: ${config.UPSTREAM_BASE_URL}`);
    console.log(`🛡️  Error Sanitizer & Membership Protection: Active`);
    console.log(`🔑 Admin Initial Login: ${config.INITIAL_ADMIN_EMAIL}`);
    console.log(`=======================================================`);
  } catch (err) {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
