import { config } from './config';
import { logger } from './utils/logger';
import { createApp } from './app';
import { startWorkers } from './services/scheduler.service';
import { checkUncheckedPages } from './lib/page-health';

async function start() {
  try {
    const app = createApp();

    // Background jobs (MariaDB queue) run in this same process
    if (config.env !== 'test') {
      startWorkers();
      // Pages connected before token health existed: learn which app issued their tokens
      void checkUncheckedPages();
    }

    app.listen(config.port, () => {
      logger.info(`Auto Post API listening on ${config.port} (${config.env}) — ${config.apiUrl}/api · health ${config.apiUrl}/health`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

void start();
