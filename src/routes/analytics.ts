import { Router, type Request, type Response } from 'express';
import type { Document, Filter, ObjectId } from 'mongodb';
import { getDb } from '../db.js';
import { serverError } from '../lib/http.js';
import { toObjectId } from '../lib/ids.js';
import {
  verifyAdmin,
  verifyOwnerOrAdmin,
  verifyToken,
} from '../middleware/jwt-auth.js';

const router = Router();

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

type MonthBucket = {
  key: string;
  month: string;
  bookings: number;
  revenue: number;
};

function monthBuckets(): MonthBucket[] {
  const now = new Date();
  const buckets: MonthBucket[] = [];

  for (let offset = 11; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    buckets.push({ key, month: MONTH_LABELS[date.getUTCMonth()], bookings: 0, revenue: 0 });
  }
  return buckets;
}

function monthKey(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

type AnalyticsScope = {
  bookingFilter: Filter<Document>;
  equipmentFilter: Filter<Document>;
  paymentFilter: Filter<Document>;
};

type RevenueEntry = {
  bookingId: string;
  amount: number;
  date: Date;
};

/**
 * Payments are the source of truth for new transactions. Paid bookings with no
 * matching payment record are seeded/legacy data and still count, so existing
 * dashboard numbers do not disappear after Stripe is introduced.
 */
function revenueEntries(bookings: Document[], payments: Document[]): RevenueEntry[] {
  const recordedBookingIds = new Set(
    payments.map((payment) => String(payment.bookingId ?? '')).filter(Boolean),
  );
  const entries: RevenueEntry[] = [];

  for (const payment of payments) {
    if (payment.status !== 'paid') continue;
    const date = new Date(String(payment.paidAt ?? payment.createdAt ?? ''));
    entries.push({
      bookingId: String(payment.bookingId ?? ''),
      amount: Number(payment.amount ?? 0),
      date,
    });
  }

  for (const booking of bookings) {
    const bookingId = String(booking._id);
    if (recordedBookingIds.has(bookingId)) continue;
    if (booking.paymentStatus !== 'paid' || booking.bookingStatus === 'cancelled') {
      continue;
    }
    entries.push({
      bookingId,
      amount: Number(booking.total ?? 0),
      date: new Date(String(booking.createdAt ?? '')),
    });
  }

  return entries.filter(
    (entry) =>
      Number.isFinite(entry.amount) &&
      entry.amount > 0 &&
      !Number.isNaN(entry.date.getTime()),
  );
}

async function totalsFor(scope: AnalyticsScope) {
  const db = getDb();
  const [bookings, equipment, users, payments] = await Promise.all([
    db.collection('bookings').find(scope.bookingFilter).toArray(),
    db.collection('equipment').find(scope.equipmentFilter).toArray(),
    db.collection('user').find({}).project({ role: 1 }).toArray(),
    db.collection('payments').find(scope.paymentFilter).toArray(),
  ]);

  const completed = bookings.filter(
    (booking) => booking.bookingStatus === 'completed',
  );
  const revenue = revenueEntries(bookings, payments).reduce(
    (sum, entry) => sum + entry.amount,
    0,
  );

  return {
    bookings,
    equipment,
    payments,
    totals: {
      users: users.length,
      equipment: equipment.length,
      bookings: bookings.length,
      pendingApprovals: equipment.filter((item) => item.status === 'pending').length,
      completedRentals: completed.length,
      revenue,
      listedEquipment: equipment.filter((item) => item.status === 'approved').length,
      completedOwnerRentals: completed.length,
      earnings: revenue,
    },
  };
}

function buildAnalytics(
  bookings: Document[],
  equipment: Document[],
  totals: Awaited<ReturnType<typeof totalsFor>>['totals'],
  entries: RevenueEntry[],
) {
  const buckets = monthBuckets();
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  for (const booking of bookings) {
    const bucket = byKey.get(monthKey(booking.createdAt));
    if (bucket) bucket.bookings += 1;
  }

  for (const entry of entries) {
    const bucket = byKey.get(monthKey(entry.date.toISOString()));
    if (bucket) bucket.revenue += entry.amount;
  }

  const categories = new Map<string, number>();
  for (const item of equipment) {
    const category = String(item.category ?? '');
    if (!category) continue;
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }

  return {
    months: buckets.map(({ month, bookings: count, revenue }) => ({
      month,
      bookings: count,
      revenue,
    })),
    totals,
    byCategory: [...categories.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * GET /api/analytics/admin
 * Platform-wide month series and counters for the admin dashboard.
 */
router.get(
  '/admin',
  verifyToken,
  verifyAdmin,
  async (_request: Request, response: Response) => {
    try {
      const { bookings, equipment, totals, payments } = await totalsFor({
        bookingFilter: {},
        equipmentFilter: {},
        paymentFilter: { status: { $in: ['paid', 'refunded'] } },
      });
      response.json(
        buildAnalytics(bookings, equipment, totals, revenueEntries(bookings, payments)),
      );
    } catch (error) {
      console.error('Failed to load admin analytics:', error);
      serverError(response, 'Failed to load platform analytics.');
    }
  },
);

/**
 * GET /api/analytics/owner
 * The signed-in owner's month series. Admins may pass `ownerId` to inspect
 * a specific owner.
 */
router.get(
  '/owner',
  verifyToken,
  verifyOwnerOrAdmin,
  async (request: Request, response: Response) => {
    try {
      const user = request.user!;
      const requested =
        user.role === 'admin' && typeof request.query.ownerId === 'string'
          ? toObjectId(request.query.ownerId)
          : null;
      const ownerId: ObjectId | null =
        requested ?? (user.role === 'owner' ? toObjectId(user.id) : null);

      if (!ownerId) {
        response.status(400).json({ error: 'An owner id is required.' });
        return;
      }

      const { bookings, equipment, totals, payments } = await totalsFor({
        bookingFilter: { ownerId },
        equipmentFilter: { ownerId },
        paymentFilter: { ownerId, status: { $in: ['paid', 'refunded'] } },
      });
      response.json(
        buildAnalytics(bookings, equipment, totals, revenueEntries(bookings, payments)),
      );
    } catch (error) {
      console.error('Failed to load owner analytics:', error);
      serverError(response, 'Failed to load your analytics.');
    }
  },
);

export default router;
