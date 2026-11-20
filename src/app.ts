import dotenv from 'dotenv';
dotenv.config();

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import { connectToMongoDB, disconnectFromMongoDB, client, getDb } from './db.js';
import equipmentRouter from './routes/equipment.js';

const app: Express = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());

app.get('/', (req: Request, res: Response) => {
  res.send('Yardclub server is running');
});

// Dashboard routes. These expect the Next.js server to supply the signed-in
// user through the internal auth bridge.
app.use('/api/equipment', equipmentRouter);

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

// GET /equipment - get all equipment items from database
app.get('/equipment', async (req: Request, res: Response) => {
  try {
    const database = client.db(process.env.DB_NAME || 'yardclubDB');
    const myColl = database.collection('equipment');
    const cursor = myColl.find({});
    const allValues = await cursor.toArray();
    res.json(allValues);
  } catch (error) {
    console.error('Error fetching equipment:', error);
    res.status(500).json({ error: 'Failed to fetch equipment' });
  }
});

// GET /bookings - get all rental bookings from database
app.get('/bookings', async (req: Request, res: Response) => {
  try {
    const database = client.db(process.env.DB_NAME || 'yardclubDB');
    const myColl = database.collection('bookings');
    const cursor = myColl.find({});
    const allValues = await cursor.toArray();
    res.json(allValues);
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// GET /rentals - alias for /bookings
app.get('/rentals', async (req: Request, res: Response) => {
  try {
    const database = client.db(process.env.DB_NAME || 'yardclubDB');
    const myColl = database.collection('bookings');
    const cursor = myColl.find({});
    const allValues = await cursor.toArray();
    res.json(allValues);
  } catch (error) {
    console.error('Error fetching rentals:', error);
    res.status(500).json({ error: 'Failed to fetch rentals' });
  }
});

// GET /categories - get all categories from database
app.get('/categories', async (req: Request, res: Response) => {
  try {
    const database = client.db(process.env.DB_NAME || 'yardclubDB');
    const myColl = database.collection('categories');
    const cursor = myColl.find({});
    const allValues = await cursor.toArray();
    res.json(allValues);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// GET /reviews - get all customer reviews from database
app.get('/reviews', async (req: Request, res: Response) => {
  try {
    const database = client.db(process.env.DB_NAME || 'yardclubDB');
    const myColl = database.collection('reviews');
    const cursor = myColl.find({});
    const allValues = await cursor.toArray();
    res.json(allValues);
  } catch (error) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// GET /favorites - get all saved favorites from database
app.get('/favorites', async (req: Request, res: Response) => {
  try {
    const database = client.db(process.env.DB_NAME || 'yardclubDB');
    const myColl = database.collection('favorites');
    const cursor = myColl.find({});
    const allValues = await cursor.toArray();
    res.json(allValues);
  } catch (error) {
    console.error('Error fetching favorites:', error);
    res.status(500).json({ error: 'Failed to fetch favorites' });
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

