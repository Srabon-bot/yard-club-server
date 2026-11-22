import 'dotenv/config';

import { MongoClient, type Db } from 'mongodb';

const DB_NAME = process.env.DB_NAME || 'yardclubDB';
const SERVER_SELECTION_TIMEOUT_MS = 5_000;

let client: MongoClient | undefined;
let connection: Promise<MongoClient> | undefined;

/**
 * The connection string is read only when a connection is actually needed so
 * importing the Express app (as Vercel does) never fails just because the
 * environment has not been injected yet.
 */
function connectionUri(): string {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const host = process.env.DB_HOST;
  if (user && password && host) {
    return `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/`;
  }

  throw new Error(
    'MongoDB is not configured. Set MONGODB_URI (or DB_USER, DB_PASSWORD and DB_HOST).',
  );
}

function mongoClient(): MongoClient {
  if (!client) {
    client = new MongoClient(connectionUri(), {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    });
  }
  return client;
}

/**
 * Connects once and reuses the pool across warm serverless invocations.
 * Errors are propagated so callers can fail fast with a clear message.
 */
export async function connectToMongoDB(): Promise<MongoClient> {
  if (!connection) {
    connection = mongoClient()
      .connect()
      .then((connected) => {
        console.log('Connected to MongoDB.');
        return connected;
      })
      .catch((error: unknown) => {
        // Allow a later request to retry instead of caching a failed connect.
        connection = undefined;
        throw error;
      });
  }
  return connection;
}

/** Light liveness probe used by /api/health; never throws. */
export async function pingDatabase(timeoutMs = 3_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      (async () => {
        const connected = await connectToMongoDB();
        await connected.db(DB_NAME).admin().ping();
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('MongoDB ping timed out.')),
          timeoutMs,
        );
      }),
    ]);
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Call this only when the application terminates. */
export async function disconnectFromMongoDB(): Promise<void> {
  if (!connection) return;
  try {
    const connected = await connection;
    await connected.close();
  } finally {
    connection = undefined;
    client = undefined;
  }
}

export function getDb(name: string = DB_NAME): Db {
  return mongoClient().db(name);
}
