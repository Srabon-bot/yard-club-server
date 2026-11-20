import dotenv from 'dotenv';
dotenv.config();

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import { connectToMongoDB, disconnectFromMongoDB, client, getDb } from './db.js';

const app: Express = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());

app.get('/', (req: Request, res: Response) => {
  res.send('Yardclub server is running');
});

// GET /users - get all users from database
app.get('/users', async (req: Request, res: Response) => {
  try {
    const database = client.db(process.env.DB_NAME || 'yardclubDB');
    const myColl = database.collection('user');
    const cursor = myColl.find({});
    const allValues = await cursor.toArray();
    res.json(allValues);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
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

