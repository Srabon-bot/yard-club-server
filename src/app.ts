import dotenv from 'dotenv';
dotenv.config();

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import { connectToMongoDB, disconnectFromMongoDB, getDb } from './db.js';

const app: Express = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());

app.get('/', (req: Request, res: Response) => {
  res.send('Yardclub server is running');
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

export { app, getDb };

