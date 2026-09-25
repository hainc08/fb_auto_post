import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { config } from './config';
import { logger } from './utils/logger';
import { asyncHandler, createError, errorHandler, notFoundHandler } from './middleware/error.middleware';
import { basicAuthGate } from './middleware/basic-auth.middleware';

// Route imports
import authRoutes from './routes/auth.routes';
import pagesRoutes from './routes/pages.routes';
import templatesRoutes from './routes/templates.routes';
import postsRoutes from './routes/posts.routes';
import schedulesRoutes from './routes/schedules.routes';
import analyticsRoutes from './routes/analytics.routes';
import settingsRoutes from './routes/settings.routes';
import imagesRoutes from './routes/images.routes';

// Worker imports
import { getWorker, startWorkers } from './services/scheduler.service';
import { countDueJobs, workerStatus } from './lib/job-queue';
import { safeEqual } from './middleware/basic-auth.middleware';
import { checkUncheckedPages } from './lib/page-health';

const app = express();

// ─── Middleware ──────────────────────────────────

// Behind the hosting proxy (HTTPS terminated upstream)
app.set('trust proxy', 1);

const gate = basicAuthGate(process.env.BASIC_AUTH_USER, process.env.BASIC_AUTH_PASS);
if (gate) {
  app.use(gate);
} else if (config.env === 'production') {
  logger.warn('⚠️  BASIC_AUTH_USER/BASIC_AUTH_PASS not set: the app (settings, API keys, publishing) is open to anyone with the URL');
}

app.use(cors({
  origin: [config.clientUrl, 'http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.headers['user-agent']?.substring(0, 50),
  });
  next();
});

// ─── Health Check ───────────────────────────────

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

// ─── Cron tick ──────────────────────────────────
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

// ─── API Routes ─────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api/pages', pagesRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/schedules', schedulesRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/images', imagesRoutes);

// ─── API Documentation (Simple) ─────────────────

app.get('/api', (_req, res) => {
  res.json({
    name: 'Auto Post Facebook API',
    version: '1.0.0',
    description: 'SaaS API for automated Facebook Page posting with AI content generation',
    endpoints: {
      auth: {
        'POST /api/auth/register': 'Register new account',
        'POST /api/auth/login': 'Login',
        'GET /api/auth/me': 'Get current user',
        'GET /api/auth/facebook': 'Get Facebook OAuth URL',
        'GET /api/auth/facebook/callback': 'Facebook OAuth callback',
        'POST /api/auth/api-keys': 'Generate API key',
      },
      pages: {
        'GET /api/pages': 'List connected Facebook pages',
        'POST /api/pages/connect': 'Connect Facebook pages',
        'DELETE /api/pages/:id': 'Disconnect a page',
      },
      templates: {
        'GET /api/templates': 'List content templates',
        'POST /api/templates': 'Create a template',
        'PUT /api/templates/:id': 'Update a template',
        'DELETE /api/templates/:id': 'Delete a template',
      },
      posts: {
        'GET /api/posts': 'List posts (with filters)',
        'POST /api/posts': 'Create a post',
        'POST /api/posts/:id/generate': 'Generate AI content',
        'POST /api/posts/:id/preview-image': 'Preview AI-generated image',
        'POST /api/posts/:id/improve': 'Improve caption with AI',
        'POST /api/posts/:id/publish': 'Publish post (enqueue pipeline)',
        'DELETE /api/posts/:id': 'Delete a post',
      },
      schedules: {
        'GET /api/schedules': 'List schedules',
        'POST /api/schedules': 'Create a schedule (PRO+)',
        'PUT /api/schedules/:id': 'Update a schedule',
        'PATCH /api/schedules/:id/toggle': 'Toggle schedule active/inactive',
        'DELETE /api/schedules/:id': 'Delete a schedule',
      },
      analytics: {
        'GET /api/analytics/overview': 'Dashboard overview stats',
        'GET /api/analytics/posts-timeline': 'Posts timeline chart data',
        'GET /api/analytics/pages-performance': 'Page performance metrics',
      },
    },
  });
});

// ─── Web client (production build) ──────────────
// Same origin as the API, so no CORS and one Node app on the host.

const clientDist = path.resolve(process.cwd(), 'client', 'dist');
if (existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  // SPA fallback: any non-API GET returns index.html (React Router handles the path)
  app.get(/^\/(?!api\/|api$|health$).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// ─── Error Handling ─────────────────────────────

app.use(notFoundHandler);
app.use(errorHandler);

// ─── Start Server ───────────────────────────────

async function start() {
  try {
    // Background jobs (MariaDB queue) run in this same process
    if (config.env !== 'test') {
      startWorkers();
      // Pages connected before token health existed: learn which app issued their tokens
      void checkUncheckedPages();
    }

    // Start server
    app.listen(config.port, () => {
      logger.info(`
╔══════════════════════════════════════════════╗
║     🚀 Auto Post Facebook API Server        ║
║                                              ║
║  Status:  RUNNING                            ║
║  Port:    ${String(config.port).padEnd(36)}║
║  Env:     ${config.env.padEnd(36)}║
║  API:     ${(config.apiUrl + '/api').padEnd(36)}║
║  Health:  ${(config.apiUrl + '/health').padEnd(36)}║
║                                              ║
╚══════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

export default app;
