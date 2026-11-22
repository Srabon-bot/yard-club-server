import 'dotenv/config';

import { connectToMongoDB, disconnectFromMongoDB, getDb } from '../db.js';

/**
 * One-time / admin utility to set or change a user role by email.
 * Usage: npm run user:set-role -- email@example.com --role owner
 */
function requestedEmail(): string {
  const emailIndex = process.argv.indexOf('--email');
  const roleIndex = process.argv.indexOf('--role');
  const email =
    (emailIndex >= 0 ? process.argv[emailIndex + 1] : undefined) ??
    (process.argv[2] ?? process.env.DEMO_USER_EMAIL ?? '');
  const role =
    (roleIndex >= 0 ? process.argv[roleIndex + 1] : undefined) ??
    process.env.DEMO_USER_ROLE ??
    'customer';
  return `${email}`.trim().toLowerCase();
}

function requestedRole(): string {
  const roleIndex = process.argv.indexOf('--role');
  const value =
    (roleIndex >= 0 ? process.argv[roleIndex + 1] : undefined) ??
    process.env.DEMO_USER_ROLE ??
    'customer';
  const role = `${value}`.trim().toLowerCase();
  if (!['customer', 'owner', 'admin'].includes(role)) {
    throw new Error(
      `Invalid role "${role}". Use one of: customer, owner, admin.`,
    );
  }
  return role;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function run(): Promise<void> {
  const email = requestedEmail();
  const role = requestedRole();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Usage: npm run user:set-role -- email@example.com --role owner');
  }

  await connectToMongoDB();
  try {
    const users = getDb().collection('user');
    const user = await users.findOneAndUpdate(
      { email: { $regex: new RegExp(`^${escapeRegExp(email)}$`, 'i') } },
      { $set: { role, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!user) {
      throw new Error('No existing user was found with that email address.');
    }
    console.log(`User ${user.email} (${user.id}) role set to "${user.role}".`);
  } finally {
    await disconnectFromMongoDB();
  }
}

run().catch((error: unknown) => {
  console.error('User role update failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
