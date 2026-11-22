import { Router, type Request, type Response } from 'express';
import { getDb } from '../db.js';
import { slugFor, toApiUser } from '../lib/equipment-service.js';
import { badRequest, serverError, text } from '../lib/http.js';
import { toObjectId } from '../lib/ids.js';
import { verifyToken } from '../middleware/jwt-auth.js';

const router = Router();

/**
 * GET /api/profile
 * Full record for the signed-in user.
 */
router.get('/', verifyToken, async (request: Request, response: Response) => {
  try {
    const userId = toObjectId(request.user!.id);
    if (!userId) {
      response.status(401).json({ error: 'Invalid user id.' });
      return;
    }

    const user = await getDb().collection('user').findOne({ _id: userId });
    if (!user) {
      response.status(404).json({ error: 'User not found.' });
      return;
    }

    response.json({
      user: {
        ...toApiUser(user),
        status: String(user.status ?? 'active'),
      },
    });
  } catch (error) {
    console.error('Failed to load profile:', error);
    serverError(response, 'Failed to load your profile.');
  }
});

/**
 * PATCH /api/profile
 * Updates the fields the profile form owns. Email and password stay with
 * Better Auth; image uploads will move to ImgBB later.
 */
router.patch('/', verifyToken, async (request: Request, response: Response) => {
  try {
    const userId = toObjectId(request.user!.id);
    if (!userId) {
      response.status(401).json({ error: 'Invalid user id.' });
      return;
    }

    const body = request.body ?? {};
    const update: Record<string, unknown> = {};

    if ('name' in body) {
      const name = text(body.name);
      if (name.length < 2) {
        return badRequest(response, 'name', 'Enter your full name.');
      }
      update.name = name;
    }
    if ('phone' in body) {
      update.phone = text(body.phone);
    }
    if ('address' in body) {
      update.address = text(body.address);
    }
    if ('bio' in body) {
      update.bio = text(body.bio).slice(0, 600);
    }
    if ('image' in body) {
      update.image = text(body.image);
    }

    if (Object.keys(update).length === 0) {
      return badRequest(response, 'body', 'Nothing to update.');
    }

    const db = getDb();
    const existing = await db.collection('user').findOne({ _id: userId });
    if (!existing) {
      response.status(404).json({ error: 'User not found.' });
      return;
    }

    update.updatedAt = new Date();
    await db.collection('user').updateOne({ _id: userId }, { $set: update });

    if (typeof update.name === 'string' && existing.role === 'owner') {
      await db
        .collection('equipment')
        .updateMany({ ownerId: userId }, { $set: { ownerSlug: slugFor(update.name) } });
    }

    const saved = await db.collection('user').findOne({ _id: userId });

    response.json({
      user: saved
        ? {
            ...toApiUser(saved),
            status: String(saved.status ?? 'active'),
          }
        : null,
    });
  } catch (error) {
    console.error('Failed to update profile:', error);
    serverError(response, 'Failed to update your profile.');
  }
});

export default router;
