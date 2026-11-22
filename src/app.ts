import dotenv from 'dotenv';
dotenv.config();

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import cron, { type ScheduledTask } from 'node-cron';
import { connectToMongoDB, disconnectFromMongoDB } from './db.js';
import { sweepBookingStatuses } from './services/booking-status.js';
import adminRouter from './routes/admin.js';
import analyticsRouter from './routes/analytics.js';
import bookingsRouter from './routes/bookings.js';
import equipmentRouter from './routes/equipment.js';
import favoritesRouter from './routes/favorites.js';
import profileRouter from './routes/profile.js';
import publicRouter from './routes/public.js';

const app: Express = express();
const port = process.env.PORT || 5000;

/** Opt-in because a single sweep is enough on most deployments. */
function scheduleBookingStatusSweep(): ScheduledTask | undefined {
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

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(cors());

app.get('/', (_request: Request, response: Response) => {
  response.send('Yardclub server is running');
});

// Public catalogue, owners, reviews and landing-page counters.
app.use('/api', publicRouter);

// Signed-in routes. The Next.js server forwards a Better Auth JWT, which each
// router verifies against the Better Auth JWKS before checking the DB role.
app.use('/api/equipment', equipmentRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/favorites', favoritesRouter);
app.use('/api/profile', profileRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/admin', adminRouter);

app.use('/api', (_request: Request, response: Response) => {
  response.status(404).json({ error: 'API route not found.' });
});

app.use((error: Error, _request: Request, response: Response, _next: unknown) => {
  console.error('Unhandled API error:', error);
  response.status(500).json({ error: 'Something went wrong on the server.' });
});

async function startServer() {
  await connectToMongoDB();
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

startServer();

export { app };
