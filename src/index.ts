import { config } from './config';
import { pool } from './db';
import app from './app';
import { bootstrapMerchant } from './services/bootstrap';
import { startPollingJob } from './jobs/pollTransactions';

/**
 * Application entry point. Runs in order:
 * 1. Verifies the database connection
 * 2. Runs bootstrapMerchant() to provision the Mural account/counterparty/webhook
 * 3. Starts the background polling job that checks for new deposits
 * 4. Starts the HTTP server
 */
async function main() {
  // Test DB connection
  try {
    await pool.query('SELECT 1');
    console.log('[Startup] Database connected.');
  } catch (err) {
    console.error('[Startup] Failed to connect to database:', err);
    process.exit(1);
  }

  // Bootstrap merchant (account, counterparty, webhook)
  try {
    await bootstrapMerchant();
  } catch (err) {
    console.error('[Startup] Bootstrap failed:', err);
    // Don't exit — partial setup may still be usable
  }

  // Start background polling
  startPollingJob();

  // Start HTTP server
  app.listen(config.port, () => {
    console.log(`[Startup] Server running on port ${config.port}`);
    console.log(`[Startup] Health: http://localhost:${config.port}/health`);
  });
}

main().catch((err) => {
  console.error('[Startup] Fatal error:', err);
  process.exit(1);
});
