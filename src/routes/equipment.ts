import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { getDb } from '../db.js';
import { toApi, toObjectId, slugify } from '../lib/ids.js';
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

type Counts = {
  all: number;
  approved: number;
  pending: number;
  rejected: number;
};

function emptyCounts(): Counts {
  return { all: 0, approved: 0, pending: 0, rejected: 0 };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function validationError(
  response: Response,
  field: string,
  message: string,
): void {
  response.status(400).json({ error: message, field });
}

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

      const requested = text(request.query.status).toLowerCase();
      if (requested && requested !== 'all' && !STATUSES.has(requested)) {
        validationError(response, 'status', 'Unknown equipment status.');
        return;
      }

      const scope = { ownerId };
      const query = requested && requested !== 'all'
        ? { ownerId, status: requested }
        : scope;

      const collection = getDb().collection('equipment');
      const [documents, groups] = await Promise.all([
        collection.find(query).sort({ createdAt: -1 }).toArray(),
        collection
          .aggregate<{ _id: string; count: number }>([
            { $match: scope },
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

      response.json({ items: documents.map(toApi), counts });
    } catch (error) {
      console.error('Failed to load owner equipment:', error);
      response.status(500).json({ error: 'Failed to load your equipment.' });
    }
  },
);

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

      if (!name) return validationError(response, 'name', 'Equipment name is required.');
      if (!brand) return validationError(response, 'brand', 'Brand is required.');
      if (!model) return validationError(response, 'model', 'Model is required.');
      if (!CATEGORIES.has(category)) {
        return validationError(response, 'category', 'Choose a valid category.');
      }
      if (!description) {
        return validationError(response, 'description', 'Description is required.');
      }
      if (!location) {
        return validationError(response, 'location', 'Location is required.');
      }
      if (!Number.isInteger(quantity) || quantity < 1) {
        return validationError(response, 'quantity', 'Quantity must be a whole number above zero.');
      }
      if (!CONDITIONS.has(condition)) {
        return validationError(response, 'condition', 'Choose a valid condition grade.');
      }
      if (!Number.isFinite(pricePerDay) || pricePerDay <= 0) {
        return validationError(response, 'pricePerDay', 'Daily price must be above zero.');
      }
      if (!image) {
        return validationError(response, 'image', 'Equipment image URL is required.');
      }
      if (!terms) {
        return validationError(response, 'terms', 'Rental terms are required.');
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
        return validationError(
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
      response.status(500).json({ error: 'Failed to create the listing.' });
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

      const equipmentId = Array.isArray(request.params.id)
        ? (request.params.id[0] ?? '')
        : request.params.id;
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

      await collection.deleteOne({ _id: listing._id });
      await getDb()
        .collection('favorites')
        .deleteMany({ equipmentId: listing._id });

      response.json({
        deleted: true,
        id: String(listing._id),
        name: String(listing.name ?? ''),
      });
    } catch (error) {
      console.error('Failed to delete equipment:', error);
      response.status(500).json({ error: 'Failed to delete the listing.' });
    }
  },
);

export default router;
