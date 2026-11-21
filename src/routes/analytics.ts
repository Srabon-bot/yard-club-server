import { Router, type Request, type Response } from 'express';
import type { Document, Filter, ObjectId } from 'mongodb';
import { getDb } from '../db.js';
import { serverError } from '../lib/http.js';
import { toObjectId } from '../lib/ids.js';
import { loadUser, requireRole } from '../middleware/internal-auth.js';

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
};

async function totalsFor(scope: AnalyticsScope) {
  const db = getDb();
  const [bookings, equipment, users] = await Promise.all([
    db.collection('bookings').find(scope.bookingFilter).toArray(),
    db.collection('equipment').find(scope.equipmentFilter).toArray(),
    db.collection('user').find({}).project({ role: 1 }).toArray(),
  ]);

  const completed = bookings.filter(
    (booking) => booking.bookingStatus === 'completed',
  );
  const collected = bookings.filter(
    (booking) =>
      booking.paymentStatus === 'paid' && booking.bookingStatus !== 'cancelled',
  );

  return {
    bookings,
    equipment,
    totals: {
      users: users.length,
      equipment: equipment.length,
      bookings: bookings.length,
      pendingApprovals: equipment.filter((item) => item.status === 'pending').length,
      completedRentals: completed.length,
      revenue: collected.reduce(
        (sum, booking) => sum + Number(booking.total ?? 0),
        0,
      ),
      listedEquipment: equipment.filter((item) => item.status === 'approved').length,
      completedOwnerRentals: completed.length,
      earnings: collected.reduce(
        (sum, booking) => sum + Number(booking.total ?? 0),
        0,
      ),
    },
  };
}

function buildAnalytics(
  bookings: Document[],
  equipment: Document[],
  totals: Awaited<ReturnType<typeof totalsFor>>['totals'],
) {
  const buckets = monthBuckets();
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  for (const booking of bookings) {
    const bucket = byKey.get(monthKey(booking.createdAt));
    if (!bucket) continue;
    bucket.bookings += 1;
    if (booking.paymentStatus === 'paid' && booking.bookingStatus !== 'cancelled') {
      bucket.revenue += Number(booking.total ?? 0);
    }
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
  loadUser,
  requireRole('admin'),
  async (_request: Request, response: Response) => {
    try {
      const { bookings, equipment, totals } = await totalsFor({
        bookingFilter: {},
        equipmentFilter: {},
      });
      response.json(buildAnalytics(bookings, equipment, totals));
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
  loadUser,
  requireRole('owner', 'admin'),
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

      const { bookings, equipment, totals } = await totalsFor({
        bookingFilter: { ownerId },
        equipmentFilter: { ownerId },
      });
      response.json(buildAnalytics(bookings, equipment, totals));
    } catch (error) {
      console.error('Failed to load owner analytics:', error);
      serverError(response, 'Failed to load your analytics.');
    }
  },
);

export default router;
