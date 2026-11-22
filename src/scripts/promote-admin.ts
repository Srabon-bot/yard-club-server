import 'dotenv/config';

import { connectToMongoDB, disconnectFromMongoDB, getDb } from '../db.js';

/** One-time bootstrap for a fresh production DB; no HTTP endpoint. */
function requestedEmail(): string {
  const flag = process.argv.indexOf('--email');
  const raw =
    flag >= 0
      ? process.argv[flag + 1]
      : (process.argv[2] ?? process.env.ADMIN_EMAIL ?? '');
  return raw.trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function run(): Promise<void> {
  const email = requestedEmail();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      'Usage: npm run admin:promote -- email@example.com (or set ADMIN_EMAIL).',
    );
  }

  await connectToMongoDB();
  try {
    const users = getDb().collection('user');
    const user = await users.findOneAndUpdate(
      { email: { $regex: new RegExp(`^${escapeRegExp(email)}$`, 'i') } },
      { $set: { role: 'admin', updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!user) {
      throw new Error('No existing user was found with that email address.');
    }
    console.log('User promoted to admin.');
  } finally {
    await disconnectFromMongoDB();
  }
}

run().catch((error: unknown) => {
  console.error('Admin promotion failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
