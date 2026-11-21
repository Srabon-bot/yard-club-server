import type { Document } from 'mongodb';
import { getDb } from '../db.js';

export type BookingStatusSweepResult = {
  activated: number;
  completed: number;
};

/**
 * Moves due bookings forward using UTC calendar-day boundaries. The filters
 * match only the current status, so repeated runs are idempotent: pending,
 * cancelled and completed bookings are never touched, and a booking that was
 * missed while the job was off finishes both transitions in one sweep.
 */
export async function sweepBookingStatuses(
  now: Date = new Date(),
): Promise<BookingStatusSweepResult> {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const changedAt = new Date(now);
  const bookings = getDb().collection<Document>('bookings');

  const started = await bookings.updateMany(
    { bookingStatus: 'upcoming', startDate: { $lte: today } },
    { $set: { bookingStatus: 'active', updatedAt: changedAt } },
  );

  const finished = await bookings.updateMany(
    { bookingStatus: 'active', endDate: { $lt: today } },
    { $set: { bookingStatus: 'completed', updatedAt: changedAt } },
  );

  return {
    activated: started.modifiedCount,
    completed: finished.modifiedCount,
  };
}
