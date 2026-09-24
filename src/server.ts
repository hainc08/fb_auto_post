import express from 'express';
import cors from 'cors';
import { config } from './config';
import { logger } from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';

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
import { initPostWorker, initScheduleWorker } from './services/scheduler.service';

const app = express();

// ─── Middleware ──────────────────────────────────

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

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    env: config.env,
  });
});

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

// ─── Error Handling ─────────────────────────────

app.use(notFoundHandler);
app.use(errorHandler);

// ─── Start Server ───────────────────────────────

async function start() {
  try {
    // Initialize workers
    if (config.env !== 'test') {
      const postWorker = initPostWorker();
      const scheduleWorker = initScheduleWorker();
      logger.info('✅ Workers initialized', {
        postWorker: postWorker.name,
        scheduleWorker: scheduleWorker.name,
      });
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
