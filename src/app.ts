import dotenv from 'dotenv';
dotenv.config();

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import { connectToMongoDB, disconnectFromMongoDB } from './db.js';
import adminRouter from './routes/admin.js';
import analyticsRouter from './routes/analytics.js';
import bookingsRouter from './routes/bookings.js';
import equipmentRouter from './routes/equipment.js';
import favoritesRouter from './routes/favorites.js';
import profileRouter from './routes/profile.js';
import publicRouter from './routes/public.js';

const app: Express = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(cors());

app.get('/', (_request: Request, response: Response) => {
  response.send('Yardclub server is running');
});

// Public catalogue, owners, reviews and landing-page counters.
app.use('/api', publicRouter);

// Signed-in routes. The Next.js server supplies the session user through the
// temporary internal bridge until the JWT middleware lands.
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

  const server = app.listen(port, () => {
    console.log(`Yardclub server running on http://localhost:${port}`);
  });

  const shutdown = async () => {
    console.log('\nShutting down server gracefully...');
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
