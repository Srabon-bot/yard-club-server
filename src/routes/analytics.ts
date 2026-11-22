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

const PAID_PAYMENT_STATUSES = ['paid', 'refunded', 'partially_refunded'];

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
  /** Owners only see themselves here; admins see the platform. */
  userFilter?: Filter<Document>;
};

type RevenueEntry = {
  bookingId: string;
  gross: number;
  refunded: number;
  net: number;
  date: Date;
};

/**
 * Payments are the source of truth. Paid bookings with no matching payment
 * record are seeded/legacy data and still count. Refunds reduce net revenue
 * instead of being silently dropped.
 */
export function revenueEntries(
  bookings: Document[],
  payments: Document[],
): RevenueEntry[] {
  const recordedBookingIds = new Set(
    payments.map((payment) => String(payment.bookingId ?? '')).filter(Boolean),
  );
  const entries: RevenueEntry[] = [];

  for (const payment of payments) {
    if (!PAID_PAYMENT_STATUSES.includes(String(payment.status))) continue;
    const gross = Number(payment.amount ?? 0);
    const refunded =
      String(payment.status) === 'refunded' && payment.refundedAmount === undefined
        ? gross
        : Number(payment.refundedAmount ?? 0);
    entries.push({
      bookingId: String(payment.bookingId ?? ''),
      gross,
      refunded,
      net: Math.max(0, gross - refunded),
      date: new Date(String(payment.paidAt ?? payment.createdAt ?? '')),
    });
  }

  for (const booking of bookings) {
    const bookingId = String(booking._id);
    if (recordedBookingIds.has(bookingId)) continue;
    if (booking.paymentStatus !== 'paid' || booking.bookingStatus === 'cancelled') {
      continue;
    }
    const gross = Number(booking.total ?? 0);
    // Legacy rows have no paidAt, so prefer the payment/fulfilment timestamp.
    const date = new Date(
      String(booking.paidAt ?? booking.updatedAt ?? booking.createdAt ?? ''),
    );
    entries.push({ bookingId, gross, refunded: 0, net: gross, date });
  }

  return entries.filter(
    (entry) =>
      Number.isFinite(entry.gross) &&
      entry.gross > 0 &&
      !Number.isNaN(entry.date.getTime()),
  );
}

async function totalsFor(scope: AnalyticsScope) {
  const db = getDb();
  const [bookings, equipment, users, payments] = await Promise.all([
    db.collection('bookings').find(scope.bookingFilter).toArray(),
    db.collection('equipment').find(scope.equipmentFilter).toArray(),
    db
      .collection('user')
      .find(scope.userFilter ?? {})
      .project({ role: 1 })
      .toArray(),
    db.collection('payments').find(scope.paymentFilter).toArray(),
  ]);

  const completed = bookings.filter(
    (booking) => booking.bookingStatus === 'completed',
  );
  const entries = revenueEntries(bookings, payments);
  const grossRevenue = entries.reduce((sum, entry) => sum + entry.gross, 0);
  const refunds = entries.reduce((sum, entry) => sum + entry.refunded, 0);
  const revenue = entries.reduce((sum, entry) => sum + entry.net, 0);

  return {
    bookings,
    equipment,
    entries,
    totals: {
      users: users.length,
      equipment: equipment.length,
      bookings: bookings.length,
      pendingApprovals: equipment.filter((item) => item.status === 'pending').length,
      completedRentals: completed.length,
      revenue,
      grossRevenue,
      refunds,
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
    if (bucket) bucket.revenue += entry.net;
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
      const { bookings, equipment, totals, entries } = await totalsFor({
        bookingFilter: {},
        equipmentFilter: {},
        paymentFilter: { status: { $in: PAID_PAYMENT_STATUSES } },
      });
      response.json(buildAnalytics(bookings, equipment, totals, entries));
    } catch (error) {
      console.error('Failed to load admin analytics:', error);
      serverError(response, 'Failed to load platform analytics.');
    }
  },
);

/**
 * GET /api/analytics/owner
 * The signed-in owner's month series. Admins may pass `ownerId` to inspect
 * a specific owner. User counts are limited to that owner, never platform-wide.
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

      const { bookings, equipment, totals, entries } = await totalsFor({
        bookingFilter: { ownerId },
        equipmentFilter: { ownerId },
        paymentFilter: { ownerId, status: { $in: PAID_PAYMENT_STATUSES } },
        userFilter: { _id: ownerId },
      });
      response.json(buildAnalytics(bookings, equipment, totals, entries));
    } catch (error) {
      console.error('Failed to load owner analytics:', error);
      serverError(response, 'Failed to load your analytics.');
    }
  },
);

export default router;
