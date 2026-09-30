import express, { Router } from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { config } from './config';
import { logger } from './utils/logger';
import { asyncHandler, createError, errorHandler, notFoundHandler } from './middleware/error.middleware';
import { basicAuthGate, safeEqual } from './middleware/basic-auth.middleware';
import { csrfGuard } from './middleware/auth.middleware';
import authRoutes from './routes/auth.routes';
import adminRoutes from './routes/admin.routes';
import pagesRoutes from './routes/pages.routes';
import templatesRoutes from './routes/templates.routes';
import domainsRoutes from './routes/domains.routes';
import formatsRoutes from './routes/formats.routes';
import postsRoutes from './routes/posts.routes';
import schedulesRoutes from './routes/schedules.routes';
import analyticsRoutes from './routes/analytics.routes';
import settingsRoutes from './routes/settings.routes';
import imagesRoutes from './routes/images.routes';
import videosRoutes from './routes/videos.routes';
import { getWorker } from './services/scheduler.service';
import { countDueJobs, workerStatus } from './lib/job-queue';

/** Every API router and its mount path (the isolation test walks this list). */
export const API_ROUTERS: ReadonlyArray<readonly [string, Router]> = [
  ['/api/auth', authRoutes],
  ['/api/admin', adminRoutes],
  ['/api/pages', pagesRoutes],
  ['/api/templates', templatesRoutes],
  ['/api/domains', domainsRoutes],
  ['/api/formats', formatsRoutes],
  ['/api/posts', postsRoutes],
  ['/api/schedules', schedulesRoutes],
  ['/api/analytics', analyticsRoutes],
  ['/api/settings', settingsRoutes],
  ['/api/images', imagesRoutes],
  ['/api/videos', videosRoutes],
];

export function createApp() {
  const app = express();

  // Behind the hosting proxy (HTTPS terminated upstream)
  app.set('trust proxy', 1);

  const gate = basicAuthGate(process.env.BASIC_AUTH_USER, process.env.BASIC_AUTH_PASS);
  if (gate) {
    app.use(gate);
  } else if (config.env === 'production') {
    logger.warn('⚠️  BASIC_AUTH_USER/BASIC_AUTH_PASS not set: the app is only protected by its own login');
  }

  app.use(cors({ origin: [config.clientUrl, 'http://localhost:5173', 'http://localhost:3000'], credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request logging
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.path}`, { ip: req.ip, userAgent: req.headers['user-agent']?.substring(0, 50) });
    next();
  });

  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        env: config.env,
        // Is the background worker alive? A growing dueJobs count means it is not.
        worker: workerStatus,
        dueJobs: await countDueJobs().catch(() => null),
      });
    })
  );

  // Hostinger may put the app to sleep when nobody visits it; a cron job calling
  // this every minute wakes it and runs whatever is due (scheduled posts…).
  //   curl -fsS "https://<domain>/cron/tick?key=<CRON_SECRET>"
  app.all(
    '/cron/tick',
    asyncHandler(async (req, res) => {
      const secret = process.env.CRON_SECRET;
      if (!secret) throw createError(404, 'Cron tick is disabled (CRON_SECRET not set)');
      const given = String(req.get('x-cron-secret') ?? req.query.key ?? '');
      if (!given || !safeEqual(given, secret)) throw createError(401, 'Invalid cron key');

      const worker = getWorker();
      if (!worker) throw createError(503, 'Worker not running');
      const processed = await worker.drain(45_000);
      res.json({ ok: true, processed, dueJobs: await countDueJobs() });
    })
  );

  app.use('/api', csrfGuard);
  for (const [mount, router] of API_ROUTERS) app.use(mount, router);

  app.get('/api', (_req, res) => {
    res.json({ name: 'Auto Post Facebook API', version: '1.0.0', routes: API_ROUTERS.map(([mount]) => mount) });
  });

  // Web client (production build): same origin as the API, one Node app on the host.
  const clientDist = path.resolve(process.cwd(), 'client', 'dist');
  if (existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    // SPA fallback: any non-API GET returns index.html (React Router handles the path)
    app.get(/^\/(?!api\/|api$|health$|cron\/).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
