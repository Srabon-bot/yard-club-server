import dotenv from 'dotenv';
dotenv.config();

import { MongoClient, type Db } from 'mongodb';

const uri =
  process.env.MONGODB_URI ||
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}/`;

export const client = new MongoClient(uri);
export const database = client.db(process.env.DB_NAME || 'yardclubDB');
export const usersCollection = database.collection('user');

export async function connectToMongoDB(): Promise<MongoClient | undefined> {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
  }
}

// Call this only when your application terminates
export async function disconnectFromMongoDB(): Promise<void> {
  await client.close();
}

export function getDb(name: string = process.env.DB_NAME || 'yardclubDB'): Db {
  return client.db(name);
}
