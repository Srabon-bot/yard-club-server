import dotenv from 'dotenv';
dotenv.config();

import { connectToMongoDB, disconnectFromMongoDB } from '../db.js';
import { sweepBookingStatuses } from '../services/booking-status.js';

/** One-shot runner for manual catch-up and smoke tests. */
async function run(): Promise<void> {
  const connection = await connectToMongoDB();
  if (!connection) throw new Error('Could not connect to MongoDB.');

  try {
    const { activated, completed, notified } = await sweepBookingStatuses();
    console.log(
      `Booking status sweep: ${activated} activated, ${completed} completed, ${notified} emails sent.`,
    );
  } finally {
    await disconnectFromMongoDB();
  }
}

run().catch((error: unknown) => {
  console.error('Booking status sweep failed:', error);
  process.exitCode = 1;
});
