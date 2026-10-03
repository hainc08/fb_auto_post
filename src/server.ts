import { config } from './config';
import { logger } from './utils/logger';
import { createApp } from './app';
import { startWorkers } from './services/scheduler.service';
import { checkUncheckedPages } from './lib/page-health';
import { runBootstrap } from './lib/bootstrap';
import { sweepVideoTmp } from './lib/video-store';
import { requeueInterruptedReels } from './services/reel.service';

async function start() {
  try {
    await runBootstrap();
    const app = createApp();

    // Background jobs (MariaDB queue) run in this same process
    if (config.env !== 'test') {
      // Reels the previous process was rendering when it stopped
      await requeueInterruptedReels().catch((e) => logger.error('[Reel] Could not requeue interrupted renders', { error: (e as Error).message }));
      startWorkers();
      // Pages connected before token health existed: learn which app issued their tokens
      void checkUncheckedPages();
      // Partial files from aborted video uploads
      void sweepVideoTmp();
      setInterval(() => void sweepVideoTmp(), 60 * 60_000).unref();
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
