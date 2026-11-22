import 'dotenv/config';

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import cron, { type ScheduledTask } from 'node-cron';
import { connectToMongoDB, disconnectFromMongoDB, pingDatabase } from './db.js';
import { sweepBookingStatuses } from './services/booking-status.js';
import adminRouter from './routes/admin.js';
import analyticsRouter from './routes/analytics.js';
import bookingsRouter from './routes/bookings.js';
import cronRouter from './routes/cron.js';
import equipmentRouter from './routes/equipment.js';
import favoritesRouter from './routes/favorites.js';
import paymentWebhookRouter from './routes/payment-webhook.js';
import paymentsRouter from './routes/payments.js';
import profileRouter from './routes/profile.js';
import publicRouter from './routes/public.js';
import { validateAuthConfig, warmJwksConfig } from './middleware/jwt-auth.js';
import { ensurePaymentIndexes } from './services/payment-service.js';

const app: Express = express();
const port = process.env.PORT || 5000;

/** CLIENT_URL plus any extra comma-separated origins; never a wildcard. */
function configuredOrigins(): Set<string> {
  const origins = new Set<string>();
  const configured = [process.env.CLIENT_URL, process.env.CORS_ORIGINS]
    .filter(Boolean)
    .join(',');

  for (const entry of configured.split(',')) {
    const value = entry.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        origins.add(url.origin);
      }
    } catch {
      console.warn('Ignoring an invalid CORS origin in configuration.');
    }
  }

  if (origins.size === 0) {
    if (process.env.VERCEL) {
      console.error(
        'CLIENT_URL/CORS_ORIGINS are not configured; cross-origin requests will be blocked.',
      );
    } else {
      origins.add('http://localhost:3000');
    }
  }
  if (!process.env.CLIENT_URL && !process.env.BETTER_AUTH_URL) {
    console.error(
      'CLIENT_URL is not configured; JWT issuer, audience and JWKS use the localhost fallback.',
    );
  }
  return origins;
}

const allowedOrigins = configuredOrigins();
app.use(
  cors({
    origin: (origin, callback) => {
      // Same-origin, server-to-server and curl requests send no Origin header.
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Stripe-Signature'],
    optionsSuccessStatus: 204,
  }),
);

app.get('/', (_request: Request, response: Response) => {
  response.json({
    success: true,
    data: {
      service: 'Yardclub API',
      status: 'running',
    },
  });
});

/** JSON health probe for Vercel/monitoring; cheap enough to call often. */
app.get('/api/health', async (_request: Request, response: Response) => {
  try {
    await pingDatabase(3_000);
    response.json({ status: 'ok', db: 'ok', uptime: Math.round(process.uptime()) });
  } catch (error) {
    console.error(
      'Health check database ping failed:',
      error instanceof Error ? error.message : error,
    );
    response.status(503).json({ status: 'error', db: 'unavailable' });
  }
});

/** Serverless invocations connect lazily, but never leave handlers hanging. */
app.use('/api', async (_request: Request, response: Response, next) => {
  try {
    await connectToMongoDB();
    next();
  } catch (error) {
    console.error(
      'Database connection failed:',
      error instanceof Error ? error.message : error,
    );
    response.status(503).json({ error: 'Database unavailable.' });
  }
});

// Stripe needs the untouched request bytes to verify its signature, so this
// route is deliberately mounted before the JSON body parser.
app.use('/api/payments/webhook', express.raw({ type: '*/*' }), paymentWebhookRouter);

// Middleware
app.use(express.json({ limit: '1mb' }));

// Public catalogue, owners, reviews and landing-page counters.
app.use('/api', publicRouter);

// Signed-in routes. The Next.js server forwards a Better Auth JWT, which each
// router verifies against the Better Auth JWKS before checking the DB role.
app.use('/api/equipment', equipmentRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/favorites', favoritesRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/cron', cronRouter);

app.use('/api', (_request: Request, response: Response) => {
  response.status(404).json({ error: 'API route not found.' });
});

app.use((_request: Request, response: Response) => {
  response.status(404).json({ error: 'Not found.' });
});

app.use(
  (
    error: Error & { status?: number },
    _request: Request,
    response: Response,
    _next: unknown,
  ) => {
    if (error.status === 400) {
      response.status(400).json({ error: 'Invalid request body.' });
      return;
    }
    console.error('Unhandled API error:', error);
    response.status(500).json({ error: 'Something went wrong on the server.' });
  },
);

/** Opt-in because a single sweep is enough on most deployments. Local only. */
function scheduleBookingStatusSweep(): ScheduledTask | undefined {
  if (process.env.VERCEL) return undefined;
  if (process.env.ENABLE_BOOKING_CRON?.toLowerCase() !== 'true') return undefined;

  const expression = process.env.BOOKING_CRON_SCHEDULE || '0 * * * *';
  if (!cron.validate(expression)) {
    console.warn(`Invalid BOOKING_CRON_SCHEDULE "${expression}"; cron disabled.`);
    return undefined;
  }

  const task = cron.schedule(
    expression,
    async () => {
      try {
        const { activated, completed, notified } = await sweepBookingStatuses();
        console.log(
          `Booking status sweep: ${activated} activated, ${completed} completed, ${notified} emails sent.`,
        );
      } catch (error) {
        console.error('Booking status sweep failed:', error);
      }
    },
    { name: 'booking-status-sweep', timezone: 'UTC', noOverlap: true },
  );

  console.log(`Booking status cron enabled (${expression} UTC).`);
  return task;
}

async function startServer() {
  if (process.env.VERCEL) return;

  validateAuthConfig();
  warmJwksConfig();
  await connectToMongoDB();
  await ensurePaymentIndexes();
  const bookingStatusTask = scheduleBookingStatusSweep();

  const server = app.listen(port, () => {
    console.log(`Yardclub server running on http://localhost:${port}`);
  });

  const shutdown = async () => {
    console.log('\nShutting down server gracefully...');
    bookingStatusTask?.stop();
    server.close(async () => {
      await disconnectFromMongoDB();
      console.log('MongoDB connection closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (!process.env.VERCEL) {
  startServer().catch((error: unknown) => {
    console.error(
      'Failed to start Yardclub server:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}

export default app;
export { app };
