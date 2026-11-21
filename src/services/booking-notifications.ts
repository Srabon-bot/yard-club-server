import type { Document, ObjectId } from 'mongodb';
import nodemailer from 'nodemailer';
import { getDb } from '../db.js';
import { toObjectId } from '../lib/ids.js';

export type BookingNotificationResult = {
  sent: number;
  skipped: number;
  failed: number;
};

function isoDay(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function money(value: unknown): string {
  return new Intl.NumberFormat('en-BD').format(Number(value ?? 0));
}

function firstName(user: Document | undefined): string {
  return String(user?.name ?? 'there').trim().split(/\s+/)[0] || 'there';
}

/** Sends one completion notice to the customer and one to the equipment owner. */
export async function notifyBookingCompleted(
  bookings: Document[],
): Promise<BookingNotificationResult> {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (bookings.length === 0) return result;

  const recipients = bookings.length * 2;
  if (process.env.ENABLE_EMAIL_NOTIFICATIONS?.toLowerCase() !== 'true') {
    console.log(
      `Email notifications disabled; skipped ${recipients} completion notice(s).`,
    );
    return { ...result, skipped: recipients };
  }

  if (
    process.env.EMAIL_TRANSPORT !== 'json' &&
    !process.env.SMTP_HOST
  ) {
    console.warn(
      'SMTP_HOST is not configured; skipped completion notification emails.',
    );
    return { ...result, skipped: recipients };
  }

  try {
    const db = getDb();
    const userIds = [
      ...new Set(
        bookings
          .flatMap((booking) => [booking.customerId, booking.ownerId])
          .filter(Boolean)
          .map((id) => String(id)),
      ),
    ]
      .map((id) => toObjectId(id))
      .filter((id): id is ObjectId => Boolean(id));
    const equipmentIds = [
      ...new Set(
        bookings
          .map((booking) => booking.equipmentId)
          .filter(Boolean)
          .map((id) => String(id)),
      ),
    ]
      .map((id) => toObjectId(id))
      .filter((id): id is ObjectId => Boolean(id));

    const [users, equipment] = await Promise.all([
      userIds.length
        ? db.collection('user').find({ _id: { $in: userIds } }).toArray()
        : Promise.resolve([]),
      equipmentIds.length
        ? db
            .collection('equipment')
            .find({ _id: { $in: equipmentIds } })
            .project({ name: 1 })
            .toArray()
        : Promise.resolve([]),
    ]);

    const userMap = new Map(users.map((user) => [String(user._id), user]));
    const equipmentMap = new Map(
      equipment.map((item) => [String(item._id), String(item.name ?? 'equipment')]),
    );

    const transporter =
      process.env.EMAIL_TRANSPORT === 'json'
        ? nodemailer.createTransport({ jsonTransport: true })
        : nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 587),
            secure: process.env.SMTP_SECURE === 'true',
            ...(process.env.SMTP_USER && process.env.SMTP_PASS
              ? {
                  auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS,
                  },
                }
              : {}),
          });

    const from = process.env.EMAIL_FROM || 'Yardclub <no-reply@yardclub.test>';

    for (const booking of bookings) {
      const reference = String(booking.bookingRef ?? 'your booking');
      const equipmentName =
        equipmentMap.get(String(booking.equipmentId)) ?? 'your equipment';
      const details = [
        `Booking: ${reference}`,
        `Equipment: ${equipmentName}`,
        `Rental dates: ${isoDay(booking.startDate)} to ${isoDay(booking.endDate)}`,
        `Total: ${money(booking.total)} BDT`,
        `Status: completed`,
      ].join('\n');

      const notices = [
        {
          user: userMap.get(String(booking.customerId ?? '')),
          subject: `Your Yardclub rental is complete (${reference})`,
          text: `Hi ${firstName(userMap.get(String(booking.customerId ?? '')))},\n\nYour rental has been marked complete. Thank you for using Yardclub.\n\n${details}\n`,
        },
        {
          user: userMap.get(String(booking.ownerId ?? '')),
          subject: `A Yardclub rental is complete (${reference})`,
          text: `Hi ${firstName(userMap.get(String(booking.ownerId ?? '')))},\n\nA rental of your equipment has been marked complete.\n\n${details}\n`,
        },
      ];

      for (const notice of notices) {
        const email = notice.user ? String(notice.user.email ?? '') : '';
        if (!email) {
          result.skipped += 1;
          continue;
        }

        try {
          const info = await transporter.sendMail({
            from,
            to: email,
            subject: notice.subject,
            text: notice.text,
          });
          if (process.env.EMAIL_TRANSPORT === 'json') {
            console.log(`[email preview ${email}] ${String(info.message)}`);
          }
          result.sent += 1;
        } catch (error) {
          result.failed += 1;
          console.error(`Failed to email ${email} about ${reference}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('Failed to prepare booking completion emails:', error);
    result.failed += recipients;
  }

  return result;
}
