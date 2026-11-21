import { Router, type Request, type Response } from 'express';
import type { Document } from 'mongodb';
import { getDb } from '../db.js';
import { decorateEquipmentList } from '../lib/equipment-service.js';
import { badRequest, serverError, uidParam } from '../lib/http.js';
import { toApi, toObjectId } from '../lib/ids.js';
import { loadUser } from '../middleware/internal-auth.js';

const router = Router();

/**
 * GET /api/favorites
 * Saved listings for the signed-in customer.
 */
router.get('/', loadUser, async (request: Request, response: Response) => {
  try {
    const userId = toObjectId(request.user!.id);
    if (!userId) {
      response.status(401).json({ error: 'Invalid user id.' });
      return;
    }

    const db = getDb();
    const favorites = await db
      .collection('favorites')
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();

    const equipmentIds = favorites
      .map((favorite) => favorite.equipmentId)
      .filter(Boolean);
    const documents = equipmentIds.length
      ? await db.collection('equipment').find({ _id: { $in: equipmentIds } }).toArray()
      : [];
    const decorated = await decorateEquipmentList(documents);
    const equipment = new Map(
      decorated.map((item) => [String(item.id), item]),
    );

    response.json({
      items: favorites.map((favorite) => ({
        ...toApi(favorite),
        customerId: String(favorite.userId),
        equipmentId: String(favorite.equipmentId),
        equipment: equipment.get(String(favorite.equipmentId)) ?? null,
      })),
    });
  } catch (error) {
    console.error('Failed to load favorites:', error);
    serverError(response, 'Failed to load your saved equipment.');
  }
});

/**
 * POST /api/favorites
 * Saves a listing. Calling it twice keeps a single row.
 */
router.post('/', loadUser, async (request: Request, response: Response) => {
  try {
    const userId = toObjectId(request.user!.id);
    const body = request.body ?? {};
    const equipmentId = toObjectId(String(body.equipmentId ?? ''));

    if (!userId) {
      response.status(401).json({ error: 'Invalid user id.' });
      return;
    }
    if (!equipmentId) {
      return badRequest(response, 'equipmentId', 'Choose a valid listing.');
    }

    const db = getDb();
    const equipment = await db.collection('equipment').findOne({
      _id: equipmentId,
      status: 'approved',
    });
    if (!equipment) {
      response.status(404).json({ error: 'Equipment not found.' });
      return;
    }

    const now = new Date();
    const result = await db.collection('favorites').findOneAndUpdate(
      { userId, equipmentId },
      {
        $setOnInsert: {
          userId,
          equipmentId,
          equipmentSlug: equipment.slug ?? '',
          createdAt: now,
        },
        $set: { updatedAt: now },
      },
      { upsert: true, returnDocument: 'after' },
    );

    const favorite = result;
    response.status(201).json({
      item: favorite
        ? {
            ...toApi(favorite as Document),
            customerId: String(userId),
            equipmentId: String(equipmentId),
          }
        : null,
      saved: true,
    });
  } catch (error) {
    console.error('Failed to save favorite:', error);
    serverError(response, 'Failed to save the listing.');
  }
});

/**
 * DELETE /api/favorites/:equipmentId
 * Removes a saved listing; safe to call when it is already gone.
 */
router.delete('/:equipmentId', loadUser, async (request: Request, response: Response) => {
  try {
    const userId = toObjectId(request.user!.id);
    const equipmentId = toObjectId(uidParam(request, 'equipmentId'));

    if (!userId) {
      response.status(401).json({ error: 'Invalid user id.' });
      return;
    }
    if (!equipmentId) {
      return badRequest(response, 'equipmentId', 'Choose a valid listing.');
    }

    const result = await getDb()
      .collection('favorites')
      .deleteOne({ userId, equipmentId });

    response.json({
      removed: result.deletedCount > 0,
      equipmentId: String(equipmentId),
    });
  } catch (error) {
    console.error('Failed to remove favorite:', error);
    serverError(response, 'Failed to remove the listing.');
  }
});

export default router;
