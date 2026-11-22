import { Router, type Request, type Response } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { getDb } from '../db.js';
import {
  availabilityFor,
  averageEquipmentRating,
  decorateEquipmentList,
  slugFor,
  toApiUser,
} from '../lib/equipment-service.js';
import {
  pagination,
  queryInt,
  queryText,
  serverError,
  uidParam,
} from '../lib/http.js';
import { toApi, toObjectId } from '../lib/ids.js';

const router = Router();

type OwnerListingStats = {
  count: number;
  available: number;
  rating: number;
  reviewCount: number;
  location: string;
  minRate: number;
};

type OwnerRow = ReturnType<typeof ownerShape>;

/** Aggregates approved listings per owner so the public owner cards stay live. */
async function ownerStats(): Promise<Map<string, OwnerListingStats>> {
  const documents = await getDb()
    .collection('equipment')
    .find({ status: 'approved' })
    .project({
      _id: 1,
      quantity: 1,
      ownerId: 1,
      location: 1,
      pricePerDay: 1,
      rating: 1,
      reviewCount: 1,
    })
    .toArray();

  const availability = await availabilityFor(documents);
  const grouped = new Map<string, Document[]>();
  for (const item of documents) {
    const key = String(item.ownerId);
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  }

  const stats = new Map<string, OwnerListingStats>();
  for (const [ownerId, items] of grouped) {
    const reviewCount = items.reduce(
      (sum, item) => sum + Number(item.reviewCount ?? 0),
      0,
    );
    stats.set(ownerId, {
      count: items.length,
      available: items.filter(
        (item) => availability.get(String(item._id))?.availableNow,
      ).length,
      rating: averageEquipmentRating(items),
      reviewCount,
      location: String(items[0]?.location ?? ''),
      minRate: Math.min(...items.map((item) => Number(item.pricePerDay ?? 0))),
    });
  }
  return stats;
}

function ownerShape(user: Document, stats: OwnerListingStats | undefined) {
  const mapped = toApiUser(user);
  return {
    id: mapped.id,
    name: mapped.name,
    initials: mapped.initials,
    email: mapped.email,
    image: mapped.image,
    slug: mapped.slug,
    location: stats?.location || mapped.address || 'Dhaka, Bangladesh',
    rating: stats ? Math.round(stats.rating * 10) / 10 : 0,
    reviewCount: stats?.reviewCount ?? 0,
    joined: mapped.joined,
    responseTime: 'under 30 min',
    verified: true,
    bio:
      mapped.bio ||
      `${mapped.name} rents equipment on Yardclub with a focus on clean, serviced gear.`,
    phone: mapped.phone,
    listingCount: stats?.count ?? 0,
    availableCount: stats?.available ?? 0,
    minRate: stats ? stats.minRate : 0,
  };
}

async function ownerDocs(ids?: string[]): Promise<Document[]> {
  const filter: Document = { role: 'owner' };
  if (ids) {
    const objectIds = ids.map((id) => toObjectId(id)).filter(Boolean) as ObjectId[];
    filter._id = { $in: objectIds };
  }
  return getDb().collection('user').find(filter).sort({ createdAt: 1 }).toArray();
}

/**
 * GET /api/categories
 * Category metadata plus a live count of approved listings.
 */
router.get('/categories', async (_request: Request, response: Response) => {
  try {
    const [categories, counts] = await Promise.all([
      getDb().collection('categories').find({}).toArray(),
      getDb()
        .collection('equipment')
        .aggregate<{ _id: string; count: number }>([
          { $match: { status: 'approved' } },
          { $group: { _id: '$category', count: { $sum: 1 } } },
        ])
        .toArray(),
    ]);

    const byId = new Map(counts.map((row) => [row._id, row.count]));

    response.json({
      items: categories.map((category) => ({
        id: String(category.id ?? category._id),
        name: String(category.name ?? ''),
        short: String(category.short ?? category.name ?? ''),
        code: String(category.code ?? ''),
        description: String(category.description ?? ''),
        count: byId.get(String(category.id)) ?? 0,
      })),
    });
  } catch (error) {
    console.error('Failed to load categories:', error);
    serverError(response, 'Failed to load categories.');
  }
});

/**
 * GET /api/owners
 * Public owner directory with live listing counts and ratings.
 */
router.get('/owners', async (request: Request, response: Response) => {
  try {
    const [stats, users] = await Promise.all([ownerStats(), ownerDocs()]);
    const q = queryText(request.query.q).toLowerCase();
    const limit = Math.min(60, Math.max(1, queryInt(request.query.limit) ?? 60));

    const rows: OwnerRow[] = users
      .map((user) => ownerShape(user, stats.get(String(user._id))))
      .filter((owner) => owner.listingCount > 0)
      .filter((owner) => {
        if (!q) return true;
        return `${owner.name} ${owner.location} ${owner.bio}`
          .toLowerCase()
          .includes(q);
      })
      .sort(
        (a, b) =>
          b.availableCount - a.availableCount ||
          b.rating - a.rating ||
          b.listingCount - a.listingCount,
      );

    response.json({ items: rows.slice(0, limit), total: rows.length });
  } catch (error) {
    console.error('Failed to load owners:', error);
    serverError(response, 'Failed to load owners.');
  }
});

/**
 * GET /api/owners/:id
 * Accepts an ObjectId or a name-derived slug.
 */
router.get('/owners/:id', async (request: Request, response: Response) => {
  try {
    const id = uidParam(request);
    const objectId = toObjectId(id);
    const users = await ownerDocs();
    const user = objectId
      ? users.find((entry) => String(entry._id) === String(objectId))
      : users.find((entry) => slugFor(String(entry.name ?? '')) === id);

    if (!user) {
      response.status(404).json({ error: 'Owner not found.' });
      return;
    }

    const [stats, equipment] = await Promise.all([
      ownerStats(),
      getDb()
        .collection('equipment')
        .find({ ownerId: user._id, status: 'approved' })
        .sort({ rating: -1, createdAt: -1 })
        .toArray(),
    ]);

    const listings = await decorateEquipmentList(equipment);
    const equipmentIds = equipment.map((item) => item._id);
    const reviews = equipmentIds.length
      ? await getDb()
          .collection('reviews')
          .find({ equipmentId: { $in: equipmentIds } })
          .sort({ date: -1 })
          .limit(12)
          .toArray()
      : [];

    const names = new Map(
      equipment.map((item) => [String(item._id), String(item.name ?? '')]),
    );

    response.json({
      owner: ownerShape(user, stats.get(String(user._id))),
      listings,
      reviews: reviews.map((review) => ({
        ...toApi(review),
        equipment: names.get(String(review.equipmentId)) ?? '',
      })),
      today: new Date().toISOString().slice(0, 10),
    });
  } catch (error) {
    console.error('Failed to load owner profile:', error);
    serverError(response, 'Failed to load the owner profile.');
  }
});

/**
 * GET /api/reviews
 * Latest customer reviews, optionally filtered by listing or owner.
 */
router.get('/reviews', async (request: Request, response: Response) => {
  try {
    const { limit } = pagination(request, 12, 60);
    const equipmentId = toObjectId(queryText(request.query.equipmentId));
    const ownerId = toObjectId(queryText(request.query.ownerId));
    const minRating = queryInt(request.query.minRating);

    const filter: Document = {};
    if (equipmentId) filter.equipmentId = equipmentId;
    if (minRating && minRating > 0) filter.rating = { $gte: minRating };

    if (ownerId) {
      const owned = await getDb()
        .collection('equipment')
        .find({ ownerId })
        .project({ _id: 1 })
        .toArray();
      filter.equipmentId = { $in: owned.map((item) => item._id) };
    }

    const reviews = await getDb()
      .collection('reviews')
      .find(filter)
      .sort({ date: -1 })
      .limit(limit)
      .toArray();

    const equipmentIds = reviews.map((review) => review.equipmentId).filter(Boolean);
    const equipment = equipmentIds.length
      ? await getDb()
          .collection('equipment')
          .find({ _id: { $in: equipmentIds } })
          .project({ _id: 1, name: 1, slug: 1 })
          .toArray()
      : [];
    const names = new Map(
      equipment.map((item) => [
        String(item._id),
        { name: String(item.name ?? ''), slug: String(item.slug ?? '') },
      ]),
    );

    response.json({
      items: reviews.map((review) => {
        const listing = names.get(String(review.equipmentId));
        return {
          ...toApi(review),
          equipment: listing?.name ?? '',
          equipmentSlug: review.equipmentSlug ?? listing?.slug ?? '',
          date: review.date
            ? new Date(String(review.date)).toISOString()
            : new Date().toISOString(),
        };
      }),
    });
  } catch (error) {
    console.error('Failed to load reviews:', error);
    serverError(response, 'Failed to load reviews.');
  }
});

/** In-memory cache for /api/stats to avoid recalculating on every hit */
let cachedStats: { data: Record<string, unknown>; expiresAt: number } | null = null;
const STATS_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * GET /api/stats
 * Public counters used by the landing page and catalogue hero.
 */
router.get('/stats', async (_request: Request, response: Response) => {
  try {
    const now = Date.now();
    if (cachedStats && cachedStats.expiresAt > now) {
      response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=120');
      response.json(cachedStats.data);
      return;
    }

    const db = getDb();
    const [equipment, users, bookings, reviews, categories] = await Promise.all([
      db.collection('equipment').find({}).project({
        _id: 1,
        status: 1,
        featured: 1,
        location: 1,
        pricePerDay: 1,
        quantity: 1,
        rating: 1,
        reviewCount: 1,
      }).toArray(),
      db.collection('user').find({}).project({ role: 1 }).toArray(),
      db
        .collection('bookings')
        .find({})
        .project({ bookingStatus: 1, total: 1, paymentStatus: 1 })
        .toArray(),
      db.collection('reviews').countDocuments(),
      db.collection('categories').countDocuments(),
    ]);

    const approved = equipment.filter((item) => item.status === 'approved');
    const availability = await availabilityFor(approved);
    const rates = approved.map((item) => Number(item.pricePerDay ?? 0));
    const cities = new Set(
      approved.map((item) => String(item.location ?? '').split(',').pop()?.trim()),
    );
    const statsData = {
      equipment: {
        total: equipment.length,
        approved: approved.length,
        pending: equipment.filter((item) => item.status === 'pending').length,
        featured: approved.filter((item) => item.featured).length,
        available: approved.filter(
          (item) => availability.get(String(item._id))?.availableNow,
        ).length,
      },
      users: {
        total: users.length,
        customers: users.filter((user) => user.role === 'customer').length,
        owners: users.filter((user) => user.role === 'owner').length,
        admins: users.filter((user) => user.role === 'admin').length,
      },
      bookings: {
        total: bookings.length,
        pending: bookings.filter((booking) => booking.bookingStatus === 'pending')
          .length,
        active: bookings.filter((booking) => booking.bookingStatus === 'active')
          .length,
        completed: bookings.filter(
          (booking) => booking.bookingStatus === 'completed',
        ).length,
        revenue: bookings
          .filter(
            (booking) =>
              booking.paymentStatus === 'paid' &&
              booking.bookingStatus !== 'cancelled',
          )
          .reduce((sum, booking) => sum + Number(booking.total ?? 0), 0),
      },
      categories,
      cities: cities.size,
      reviews,
      minRate: rates.length ? Math.min(...rates) : 0,
      averageRating: averageEquipmentRating(approved),
    };

    cachedStats = { data: statsData, expiresAt: now + STATS_CACHE_TTL_MS };
    response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=120');
    response.json(statsData);
  } catch (error) {
    console.error('Failed to load platform stats:', error);
    serverError(response, 'Failed to load platform statistics.');
  }
});

export default router;
