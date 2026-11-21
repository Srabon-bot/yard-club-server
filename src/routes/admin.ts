import { Router, type Request, type Response } from 'express';
import type { Document } from 'mongodb';
import { getDb } from '../db.js';
import {
  decorateEquipmentList,
  initialsFor,
  toApiUser,
} from '../lib/equipment-service.js';
import {
  badRequest,
  pagination,
  queryText,
  regexTerm,
  serverError,
  text,
  uidParam,
} from '../lib/http.js';
import { toObjectId } from '../lib/ids.js';
import { loadUser, requireRole } from '../middleware/internal-auth.js';

const router = Router();

const ROLES = new Set(['customer', 'owner', 'admin']);
const STATUSES = new Set(['active', 'suspended']);
const EQUIPMENT_STATUSES = new Set(['approved', 'pending', 'rejected']);

function userShape(user: Document) {
  const mapped = toApiUser(user);
  return {
    id: mapped.id,
    name: mapped.name,
    initials: initialsFor(mapped.name),
    email: mapped.email,
    image: mapped.image,
    role: mapped.role,
    joined: mapped.joined,
    phone: mapped.phone,
    address: mapped.address,
    bio: mapped.bio,
    status: String(user.status ?? 'active'),
  };
}

/**
 * GET /api/admin/users
 * Paged user directory with role and status counts.
 */
router.get(
  '/users',
  loadUser,
  requireRole('admin'),
  async (request: Request, response: Response) => {
    try {
      const q = queryText(request.query.q);
      const role = queryText(request.query.role).toLowerCase();
      const status = queryText(request.query.status).toLowerCase();

      if (role && role !== 'all' && !ROLES.has(role)) {
        return badRequest(response, 'role', 'Unknown role.');
      }
      if (status && status !== 'all' && !STATUSES.has(status)) {
        return badRequest(response, 'status', 'Unknown account status.');
      }

      const filter: Document = {};
      if (role && role !== 'all') filter.role = role;

      if (status === 'active') {
        filter.$and = [
          { $or: [{ status: { $exists: false } }, { status: 'active' }] },
        ];
      } else if (status === 'suspended') {
        filter.status = 'suspended';
      }

      if (q) {
        const term = regexTerm(q);
        filter.$or = [
          { name: term },
          { email: term },
          { phone: term },
          { address: term },
        ];
      }

      const { page, limit, skip } = pagination(request, 8, 100);
      const collection = getDb().collection('user');
      const [total, users, all] = await Promise.all([
        collection.countDocuments(filter),
        collection.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
        collection.find({}).project({ role: 1, status: 1 }).toArray(),
      ]);

      response.json({
        items: users.map(userShape),
        counts: {
          all: all.length,
          customer: all.filter((user) => user.role === 'customer').length,
          owner: all.filter((user) => user.role === 'owner').length,
          admin: all.filter((user) => user.role === 'admin').length,
          suspended: all.filter((user) => user.status === 'suspended').length,
        },
        total,
        page,
        perPage: limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (error) {
      console.error('Failed to load users:', error);
      serverError(response, 'Failed to load users.');
    }
  },
);

/**
 * PATCH /api/admin/users/:id
 * Role and account status changes. Suspension is enforced by the internal
 * auth bridge on the next request.
 */
router.patch(
  '/users/:id',
  loadUser,
  requireRole('admin'),
  async (request: Request, response: Response) => {
    try {
      const actor = request.user!;
      const userId = toObjectId(uidParam(request));
      if (!userId) {
        response.status(404).json({ error: 'User not found.' });
        return;
      }

      const collection = getDb().collection('user');
      const target = await collection.findOne({ _id: userId });
      if (!target) {
        response.status(404).json({ error: 'User not found.' });
        return;
      }

      const body = request.body ?? {};
      const update: Record<string, unknown> = {};

      if ('role' in body) {
        const role = text(body.role);
        if (!ROLES.has(role)) {
          return badRequest(response, 'role', 'Unknown role.');
        }
        update.role = role;
      }

      if ('status' in body) {
        const status = text(body.status);
        if (!STATUSES.has(status)) {
          return badRequest(response, 'status', 'Unknown account status.');
        }
        update.status = status;
      }

      if (Object.keys(update).length === 0) {
        return badRequest(response, 'body', 'Nothing to update.');
      }

      const isSelf = String(userId) === actor.id;
      if (isSelf && update.role && update.role !== 'admin') {
        response.status(409).json({
          error: 'You cannot remove your own admin access.',
        });
        return;
      }
      if (isSelf && update.status === 'suspended') {
        response.status(409).json({ error: 'You cannot suspend your own account.' });
        return;
      }

      update.updatedAt = new Date();
      await collection.updateOne({ _id: userId }, { $set: update });
      const saved = await collection.findOne({ _id: userId });

      response.json({ user: saved ? userShape(saved) : null });
    } catch (error) {
      console.error('Failed to update user:', error);
      serverError(response, 'Failed to update the user.');
    }
  },
);

/**
 * GET /api/admin/equipment
 * Every listing, including pending and rejected rows, for moderation.
 */
router.get(
  '/equipment',
  loadUser,
  requireRole('admin'),
  async (request: Request, response: Response) => {
    try {
      const status = queryText(request.query.status).toLowerCase();
      if (status && status !== 'all' && !EQUIPMENT_STATUSES.has(status)) {
        return badRequest(response, 'status', 'Unknown equipment status.');
      }

      const q = queryText(request.query.q);
      const filter: Document = {};
      if (status && status !== 'all') filter.status = status;
      if (q) {
        const term = regexTerm(q);
        filter.$or = [
          { name: term },
          { brand: term },
          { model: term },
          { location: term },
          { category: term },
        ];
      }

      const { page, limit, skip } = pagination(request, 10, 100);
      const collection = getDb().collection('equipment');
      const [total, rows, all] = await Promise.all([
        collection.countDocuments(filter),
        collection.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
        collection.find({}).project({ status: 1 }).toArray(),
      ]);

      response.json({
        items: await decorateEquipmentList(rows),
        total,
        page,
        perPage: limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        counts: {
          all: all.length,
          approved: all.filter((item) => item.status === 'approved').length,
          pending: all.filter((item) => item.status === 'pending').length,
          rejected: all.filter((item) => item.status === 'rejected').length,
        },
      });
    } catch (error) {
      console.error('Failed to load listings for moderation:', error);
      serverError(response, 'Failed to load listings.');
    }
  },
);

export default router;
