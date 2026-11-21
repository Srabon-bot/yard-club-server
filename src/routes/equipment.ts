import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Document, Filter, ObjectId } from 'mongodb';
import { getDb } from '../db.js';
import {
  availabilityFor,
  decorateEquipment,
  decorateEquipmentList,
  HOLD_STATUSES,
  ownerMap,
} from '../lib/equipment-service.js';
import { toApi, toObjectId, slugify } from '../lib/ids.js';
import {
  badRequest,
  isIsoDate,
  numberValue,
  pagination,
  queryBoolean,
  queryNumber,
  queryText,
  regexTerm,
  serverError,
  text,
  todayIso,
  uidParam,
} from '../lib/http.js';
import { loadUser, requireRole } from '../middleware/internal-auth.js';

const router = Router();

const CATEGORIES = new Set([
  'construction',
  'photography',
  'vehicles',
  'agriculture',
  'electronics',
  'event',
]);

const RENTAL_TYPES = new Set(['daily', 'weekly', 'monthly']);
const CONDITIONS = new Set(['A', 'B', 'C']);
const STATUSES = new Set(['approved', 'pending', 'rejected']);
const SORTS = new Set(['newest', 'price-asc', 'price-desc', 'rating']);
const AVAILABILITY = new Set(['all', 'available', 'rented']);

type Counts = {
  all: number;
  approved: number;
  pending: number;
  rejected: number;
};

function emptyCounts(): Counts {
  return { all: 0, approved: 0, pending: 0, rejected: 0 };
}

function sortValue(value: string): Record<string, 1 | -1> {
  switch (value) {
    case 'price-asc':
      return { pricePerDay: 1, createdAt: -1 };
    case 'price-desc':
      return { pricePerDay: -1, createdAt: -1 };
    case 'rating':
      return { rating: -1, reviewCount: -1, createdAt: -1 };
    default:
      return { createdAt: -1 };
  }
}

function publicFilter(request: Request): Filter<Document> | null {
  const filter: Filter<Document> = { status: 'approved' };
  const q = queryText(request.query.q);
  const category = queryText(request.query.category);
  const location = queryText(request.query.location);
  const rentalType = queryText(request.query.rentalType);
  const minPrice = queryNumber(request.query.minPrice ?? request.query.min);
  const maxPrice = queryNumber(request.query.maxPrice ?? request.query.max);
  const ownerId = queryText(request.query.ownerId);
  const ownerSlug = queryText(request.query.ownerSlug);

  if (category && category !== 'all') {
    if (!CATEGORIES.has(category)) return null;
    filter.category = category;
  }

  if (location && location !== 'all') {
    filter.location = regexTerm(location);
  }

  if (rentalType && rentalType !== 'all') {
    if (!RENTAL_TYPES.has(rentalType)) return null;
    filter.rentalTypes = rentalType;
  }

  if (minPrice !== undefined && minPrice >= 0) {
    filter.pricePerDay = { ...(filter.pricePerDay as object), $gte: minPrice };
  }
  if (maxPrice !== undefined && maxPrice >= 0) {
    filter.pricePerDay = { ...(filter.pricePerDay as object), $lte: maxPrice };
  }

  if (queryBoolean(request.query.featured)) {
    filter.featured = true;
  }

  if (ownerId) {
    const objectId = toObjectId(ownerId);
    if (!objectId) return null;
    filter.ownerId = objectId;
  }

  if (ownerSlug) {
    filter.ownerSlug = ownerSlug;
  }

  if (q) {
    const term = regexTerm(q);
    filter.$or = [
      { name: term },
      { brand: term },
      { model: term },
      { description: term },
      { location: term },
      { features: term },
    ];
  }

  return filter;
}

/**
 * GET /api/equipment
 * Public catalogue. Only approved listings are returned.
 */
router.get('/', async (request: Request, response: Response) => {
  try {
    const filter = publicFilter(request);
    if (!filter) {
      badRequest(response, 'filters', 'Unknown catalogue filter.');
      return;
    }

    const availabilityFilter = queryText(request.query.availability) || 'all';
    if (!AVAILABILITY.has(availabilityFilter)) {
      badRequest(response, 'availability', 'Unknown availability filter.');
      return;
    }

    const sort = queryText(request.query.sort);
    if (sort && !SORTS.has(sort)) {
      badRequest(response, 'sort', 'Unknown sort option.');
      return;
    }

    const collection = getDb().collection('equipment');

    if (availabilityFilter !== 'all') {
      const candidates = await collection
        .find(filter)
        .project({ _id: 1, quantity: 1 })
        .toArray();
      const availability = await availabilityFor(candidates);
      const ids = candidates
        .filter((item) => {
          const row = availability.get(String(item._id));
          const available = row?.availableNow ?? Number(item.quantity ?? 0) > 0;
          return availabilityFilter === 'available' ? available : !available;
        })
        .map((item) => item._id);
      filter._id = { $in: ids };
    }

    const { page, limit, skip } = pagination(request, 9, 60);
    const [total, documents] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .find(filter)
        .sort(sortValue(sort || 'newest'))
        .skip(skip)
        .limit(limit)
        .toArray(),
    ]);

    const items = await decorateEquipmentList(documents);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    response.json({
      items,
      total,
      page: Math.min(page, totalPages),
      limit,
      totalPages,
      availability: Object.fromEntries(
        items.map((item) => [String(item.id), Boolean(item.availableNow)]),
      ),
    });
  } catch (error) {
    console.error('Failed to load public equipment:', error);
    serverError(response, 'Failed to load the catalogue.');
  }
});

/**
 * GET /api/equipment/stats
 * Small aggregate used by the public catalogue hero and the home page.
 */
router.get('/stats', async (_request: Request, response: Response) => {
  try {
    const documents = await getDb()
      .collection('equipment')
      .find({ status: 'approved' })
      .project({
        _id: 1,
        quantity: 1,
        ownerId: 1,
        category: 1,
        location: 1,
        pricePerDay: 1,
        rating: 1,
        reviewCount: 1,
      })
      .toArray();

    const availability = await availabilityFor(documents);
    const rates = documents.map((item) => Number(item.pricePerDay ?? 0));
    const cities = new Set(
      documents.map((item) =>
        String(item.location ?? '').split(',').pop()?.trim(),
      ),
    );

    response.json({
      total: documents.length,
      available: documents.filter(
        (item) => availability.get(String(item._id))?.availableNow,
      ).length,
      owners: new Set(documents.map((item) => String(item.ownerId))).size,
      categories: new Set(documents.map((item) => String(item.category))).size,
      cities: cities.size,
      minRate: rates.length ? Math.min(...rates) : 0,
      averageRating: documents.length
        ? documents.reduce((sum, item) => sum + Number(item.rating ?? 0), 0) /
          documents.length
        : 0,
      reviewCount: documents.reduce(
        (sum, item) => sum + Number(item.reviewCount ?? 0),
        0,
      ),
    });
  } catch (error) {
    console.error('Failed to load equipment stats:', error);
    serverError(response, 'Failed to load catalogue statistics.');
  }
});

/**
 * GET /api/equipment/mine
 * The signed-in owner's listings with a count for each status tab.
 */
router.get(
  '/mine',
  loadUser,
  requireRole('owner', 'admin'),
  async (request: Request, response: Response) => {
    try {
      const user = request.user!;
      const ownerId = toObjectId(user.id);
      if (!ownerId) {
        response.status(401).json({ error: 'Invalid user id.' });
        return;
      }

      const requested = queryText(request.query.status).toLowerCase();
      if (requested && requested !== 'all' && !STATUSES.has(requested)) {
        badRequest(response, 'status', 'Unknown equipment status.');
        return;
      }

      const filter: Filter<Document> = { ownerId };
      if (requested && requested !== 'all') filter.status = requested;

      const collection = getDb().collection('equipment');
      const [documents, groups] = await Promise.all([
        collection.find(filter).sort({ createdAt: -1 }).toArray(),
        collection
          .aggregate<{ _id: string; count: number }>([
            { $match: { ownerId } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ])
          .toArray(),
      ]);

      const counts = emptyCounts();
      for (const group of groups) {
        if (STATUSES.has(group._id)) {
          counts[group._id as keyof Omit<Counts, 'all'>] = group.count;
        }
        counts.all += group.count;
      }

      response.json({
        items: documents.map(toApi),
        counts,
      });
    } catch (error) {
      console.error('Failed to load owner equipment:', error);
      serverError(response, 'Failed to load your equipment.');
    }
  },
);

/**
 * GET /api/equipment/:id
 * Accepts an ObjectId or a slug. Only approved listings are public.
 */
router.get('/:id', async (request: Request, response: Response) => {
  try {
    const id = uidParam(request);
    const objectId = toObjectId(id);
    const collection = getDb().collection('equipment');
    const item = await collection.findOne({
      status: 'approved',
      ...(objectId ? { _id: objectId } : { slug: id }),
    });

    if (!item) {
      response.status(404).json({ error: 'Equipment not found.' });
      return;
    }

    const owners = await ownerMap([item]);
    const availability = await availabilityFor([item]);
    const owner = owners.get(String(item.ownerId));

    const today = todayIso();
    const todayStart = new Date(`${today}T00:00:00.000Z`);
    const holds = await getDb()
      .collection('bookings')
      .find({
        equipmentId: item._id,
        bookingStatus: { $in: HOLD_STATUSES },
        endDate: { $gte: todayStart },
      })
      .sort({ startDate: 1 })
      .project({
        _id: 0,
        startDate: 1,
        endDate: 1,
        quantity: 1,
        bookingStatus: 1,
      })
      .toArray();

    const lastEnd = holds
      .map((hold) => new Date(String(hold.endDate)))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((a, b) => b.getTime() - a.getTime())[0];

    const nextAvailable = lastEnd
      ? new Date(lastEnd.getTime() + 86_400_000).toISOString().slice(0, 10)
      : today;

    const reviews = await getDb()
      .collection('reviews')
      .find({ equipmentId: item._id })
      .sort({ date: -1 })
      .limit(6)
      .toArray();

    response.json({
      item: decorateEquipment(
        item,
        owner,
        availability.get(String(item._id)),
      ),
      owner: owner ?? null,
      holds: holds.map((hold) => ({
        startDate: new Date(String(hold.startDate)).toISOString().slice(0, 10),
        endDate: new Date(String(hold.endDate)).toISOString().slice(0, 10),
        quantity: Number(hold.quantity ?? 1),
        status: hold.bookingStatus,
      })),
      nextAvailable,
      today: todayIso(),
      reviews: reviews.map((review) => ({
        ...toApi(review),
        equipment: String(item.name ?? ''),
        equipmentSlug: item.slug ?? '',
        date: review.date
          ? new Date(String(review.date)).toISOString()
          : new Date().toISOString(),
      })),
    });
  } catch (error) {
    console.error('Failed to load equipment detail:', error);
    serverError(response, 'Failed to load the listing.');
  }
});

/**
 * POST /api/equipment
 * Creates a pending listing owned by the signed-in owner.
 */
router.post(
  '/',
  loadUser,
  requireRole('owner', 'admin'),
  async (request: Request, response: Response) => {
    try {
      const user = request.user!;
      const ownerId = toObjectId(user.id);
      if (!ownerId) {
        response.status(401).json({ error: 'Invalid user id.' });
        return;
      }

      const body = request.body ?? {};
      const name = text(body.name);
      const brand = text(body.brand);
      const model = text(body.model);
      const category = text(body.category);
      const description = text(body.description);
      const location = text(body.location);
      const condition = text(body.condition);
      const image = text(body.image);
      const terms = text(body.terms);
      const pricePerDay = numberValue(body.pricePerDay);
      const quantity = numberValue(body.quantity);

      if (!name) return badRequest(response, 'name', 'Equipment name is required.');
      if (!brand) return badRequest(response, 'brand', 'Brand is required.');
      if (!model) return badRequest(response, 'model', 'Model is required.');
      if (!CATEGORIES.has(category)) {
        return badRequest(response, 'category', 'Choose a valid category.');
      }
      if (!description) {
        return badRequest(response, 'description', 'Description is required.');
      }
      if (!location) {
        return badRequest(response, 'location', 'Location is required.');
      }
      if (!Number.isInteger(quantity) || quantity < 1) {
        return badRequest(
          response,
          'quantity',
          'Quantity must be a whole number above zero.',
        );
      }
      if (!CONDITIONS.has(condition)) {
        return badRequest(response, 'condition', 'Choose a valid condition grade.');
      }
      if (!Number.isFinite(pricePerDay) || pricePerDay <= 0) {
        return badRequest(response, 'pricePerDay', 'Daily price must be above zero.');
      }
      if (!image) {
        return badRequest(response, 'image', 'Equipment image URL is required.');
      }
      if (!terms) {
        return badRequest(response, 'terms', 'Rental terms are required.');
      }

      const rawRentalTypes = Array.isArray(body.rentalTypes)
        ? body.rentalTypes
        : [body.rentalTypes];
      const rentalTypes = [
        ...new Set(
          rawRentalTypes
            .map((value: unknown) => text(value).toLowerCase())
            .filter((value: string) => RENTAL_TYPES.has(value)),
        ),
      ];
      if (rentalTypes.length === 0) {
        return badRequest(
          response,
          'rentalTypes',
          'Choose at least one rental type.',
        );
      }

      const features = Array.isArray(body.features)
        ? body.features
            .map((value: unknown) => text(value))
            .filter((value: string) => value.length > 0)
            .slice(0, 20)
        : [];

      const collection = getDb().collection('equipment');
      const baseSlug = slugify(name) || 'equipment';
      const slugTaken = await collection.findOne({ slug: baseSlug });
      const slug = slugTaken
        ? `${baseSlug}-${randomBytes(2).toString('hex')}`
        : baseSlug;

      const now = new Date().toISOString();
      const listing = {
        name,
        brand,
        model,
        category,
        description,
        pricePerDay,
        rentalTypes,
        location,
        quantity,
        condition,
        image,
        status: 'pending',
        rating: 0,
        reviewCount: 0,
        createdAt: now,
        updatedAt: now,
        terms,
        features,
        featured: false,
        slug,
        ownerId,
        ownerSlug: user.slug,
      };

      const result = await collection.insertOne(listing);

      response.status(201).json({
        item: toApi({ ...listing, _id: result.insertedId }),
      });
    } catch (error) {
      console.error('Failed to create equipment:', error);
      serverError(response, 'Failed to create the listing.');
    }
  },
);

/**
 * PATCH /api/equipment/:id
 * Owners may edit their own listing; admins may edit any listing.
 */
router.patch(
  '/:id',
  loadUser,
  requireRole('owner', 'admin'),
  async (request: Request, response: Response) => {
    try {
      const user = request.user!;
      const userId = toObjectId(user.id);
      if (!userId) {
        response.status(401).json({ error: 'Invalid user id.' });
        return;
      }

      const id = uidParam(request);
      const objectId = toObjectId(id);
      if (!objectId) {
        response.status(404).json({ error: 'Equipment not found.' });
        return;
      }

      const collection = getDb().collection('equipment');
      const listing = await collection.findOne({ _id: objectId });
      if (!listing) {
        response.status(404).json({ error: 'Equipment not found.' });
        return;
      }

      if (user.role !== 'admin' && String(listing.ownerId) !== String(userId)) {
        response.status(403).json({ error: 'You can only edit your own equipment.' });
        return;
      }

      const body = request.body ?? {};
      const update: Record<string, unknown> = {};

      if ('name' in body) {
        const name = text(body.name);
        if (!name) return badRequest(response, 'name', 'Equipment name is required.');
        update.name = name;
      }
      if ('brand' in body) {
        const brand = text(body.brand);
        if (!brand) return badRequest(response, 'brand', 'Brand is required.');
        update.brand = brand;
      }
      if ('model' in body) {
        const model = text(body.model);
        if (!model) return badRequest(response, 'model', 'Model is required.');
        update.model = model;
      }
      if ('category' in body) {
        const category = text(body.category);
        if (!CATEGORIES.has(category)) {
          return badRequest(response, 'category', 'Choose a valid category.');
        }
        update.category = category;
      }
      if ('description' in body) {
        const description = text(body.description);
        if (!description) {
          return badRequest(response, 'description', 'Description is required.');
        }
        update.description = description;
      }
      if ('location' in body) {
        const location = text(body.location);
        if (!location) return badRequest(response, 'location', 'Location is required.');
        update.location = location;
      }
      if ('condition' in body) {
        const condition = text(body.condition);
        if (!CONDITIONS.has(condition)) {
          return badRequest(response, 'condition', 'Choose a valid condition grade.');
        }
        update.condition = condition;
      }
      if ('image' in body) {
        const image = text(body.image);
        if (!image) return badRequest(response, 'image', 'Equipment image URL is required.');
        update.image = image;
      }
      if ('terms' in body) {
        const terms = text(body.terms);
        if (!terms) return badRequest(response, 'terms', 'Rental terms are required.');
        update.terms = terms;
      }
      if ('pricePerDay' in body) {
        const pricePerDay = numberValue(body.pricePerDay);
        if (!Number.isFinite(pricePerDay) || pricePerDay <= 0) {
          return badRequest(response, 'pricePerDay', 'Daily price must be above zero.');
        }
        update.pricePerDay = pricePerDay;
      }
      if ('quantity' in body) {
        const quantity = numberValue(body.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) {
          return badRequest(
            response,
            'quantity',
            'Quantity must be a whole number above zero.',
          );
        }
        update.quantity = quantity;
      }
      if ('rentalTypes' in body) {
        const raw = Array.isArray(body.rentalTypes)
          ? body.rentalTypes
          : [body.rentalTypes];
        const rentalTypes = [
          ...new Set(
            raw
              .map((value: unknown) => text(value).toLowerCase())
              .filter((value: string) => RENTAL_TYPES.has(value)),
          ),
        ];
        if (rentalTypes.length === 0) {
          return badRequest(
            response,
            'rentalTypes',
            'Choose at least one rental type.',
          );
        }
        update.rentalTypes = rentalTypes;
      }
      if ('features' in body) {
        update.features = Array.isArray(body.features)
          ? body.features
              .map((value: unknown) => text(value))
              .filter((value: string) => value.length > 0)
              .slice(0, 20)
          : [];
      }
      if ('status' in body) {
        if (user.role !== 'admin') {
          response.status(403).json({
            error: 'Only an admin can change a listing status.',
          });
          return;
        }
        const status = text(body.status);
        if (!STATUSES.has(status)) {
          return badRequest(response, 'status', 'Unknown equipment status.');
        }
        update.status = status;
      }
      if ('featured' in body) {
        if (user.role !== 'admin') {
          response.status(403).json({
            error: 'Only an admin can feature a listing.',
          });
          return;
        }
        update.featured = Boolean(body.featured);
      }

      if (Object.keys(update).length === 0) {
        return badRequest(response, 'body', 'Nothing to update.');
      }

      update.updatedAt = new Date().toISOString();
      await collection.updateOne({ _id: objectId }, { $set: update });
      const saved = await collection.findOne({ _id: objectId });

      response.json({ item: saved ? toApi(saved) : null });
    } catch (error) {
      console.error('Failed to update equipment:', error);
      serverError(response, 'Failed to update the listing.');
    }
  },
);

/**
 * DELETE /api/equipment/:id
 * Owners may remove their own listing; admins may remove any listing.
 */
router.delete(
  '/:id',
  loadUser,
  requireRole('owner', 'admin'),
  async (request: Request, response: Response) => {
    try {
      const user = request.user!;
      const ownerId = toObjectId(user.id);
      if (!ownerId) {
        response.status(401).json({ error: 'Invalid user id.' });
        return;
      }

      const equipmentId = uidParam(request);
      const objectId = toObjectId(equipmentId);
      if (!objectId) {
        response.status(404).json({ error: 'Equipment not found.' });
        return;
      }

      const collection = getDb().collection('equipment');
      const listing = await collection.findOne({ _id: objectId });

      if (!listing) {
        response.status(404).json({ error: 'Equipment not found.' });
        return;
      }

      const ownsListing = String(listing.ownerId) === String(ownerId);

      if (user.role !== 'admin' && !ownsListing) {
        response.status(403).json({ error: 'You can only delete your own equipment.' });
        return;
      }

      const activeBooking = await getDb().collection('bookings').findOne({
        equipmentId: listing._id,
        bookingStatus: { $in: HOLD_STATUSES },
      });

      if (activeBooking) {
        response.status(409).json({
          error:
            'This listing has pending, active or upcoming bookings. Cancel or complete them before deleting it.',
        });
        return;
      }

      await collection.deleteOne({ _id: listing._id });
      await getDb()
        .collection('favorites')
        .deleteMany({ equipmentId: listing._id });
      await getDb()
        .collection('reviews')
        .deleteMany({ equipmentId: listing._id });

      response.json({
        deleted: true,
        id: String(listing._id),
        name: String(listing.name ?? ''),
      });
    } catch (error) {
      console.error('Failed to delete equipment:', error);
      serverError(response, 'Failed to delete the listing.');
    }
  },
);

export { CATEGORIES, RENTAL_TYPES };
export default router;
