import type { Document } from 'mongodb';
import { getDb } from '../db.js';
import { notifyBookingCompleted } from './booking-notifications.js';

export type BookingStatusSweepResult = {
  activated: number;
  completed: number;
  notified: number;
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

  const due = await bookings
    .find({ bookingStatus: 'active', endDate: { $lt: today } })
    .toArray();
  const finished = await bookings.updateMany(
    { bookingStatus: 'active', endDate: { $lt: today } },
    { $set: { bookingStatus: 'completed', updatedAt: changedAt } },
  );
  const notification = await notifyBookingCompleted(
    finished.modifiedCount > 0 ? due : [],
  );

  return {
    activated: started.modifiedCount,
    completed: finished.modifiedCount,
    notified: notification.sent,
  };
}
