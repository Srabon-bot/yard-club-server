import { Router, type Request, type Response } from 'express';
import type { Document, Filter, ObjectId } from 'mongodb';
import { getDb } from '../db.js';
import {
  bookingCounts,
  enrichBookings,
  HOLD_STATUSES,
} from '../lib/equipment-service.js';
import {
  badRequest,
  daysBetween,
  isIsoDate,
  pagination,
  queryText,
  regexTerm,
  serverError,
  text,
  todayIso,
  uidParam,
} from '../lib/http.js';
import { toApi, toObjectId } from '../lib/ids.js';
import { verifyRenter, verifyToken } from '../middleware/jwt-auth.js';
import { notifyBookingCompleted } from '../services/booking-notifications.js';
import {
  createBookingCheckout,
  refundBookingPayment,
} from '../services/payment-service.js';

const router = Router();

const BOOKING_STATUSES = new Set([
  'pending',
  'upcoming',
  'active',
  'completed',
  'cancelled',
]);
const PAYMENT_STATUSES = new Set([
  'unpaid',
  'pending',
  'paid',
  'refunded',
  'failed',
]);

function asDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Numeric portion of the newest `YC-####` reference plus one. */
async function nextBookingRef(): Promise<string> {
  const rows = await getDb()
    .collection('bookings')
    .find({ bookingRef: { $regex: /^YC-\d+$/ } })
    .sort({ bookingRef: -1 })
    .limit(1)
    .toArray();

  const current = rows[0] ? Number(String(rows[0].bookingRef).slice(3)) : 1000;
  return `YC-${Number.isFinite(current) ? current + 1 : 1001}`;
}

async function reservedUnits(
  equipmentId: ObjectId,
  start: Date,
  end: Date,
): Promise<number> {
  const rows = await getDb()
    .collection('bookings')
    .aggregate<{ _id: null; quantity: number }>([
      {
        $match: {
          equipmentId,
          bookingStatus: { $in: HOLD_STATUSES },
          startDate: { $lte: end },
          endDate: { $gte: start },
        },
      },
      { $group: { _id: null, quantity: { $sum: '$quantity' } } },
    ])
    .toArray();

  return rows[0]?.quantity ?? 0;
}

function statusClause(request: Request): string {
  const status = queryText(request.query.status).toLowerCase();
  if (!status || status === 'all') return '';
  if (!BOOKING_STATUSES.has(status)) return '__invalid__';
  return status;
}

/**
 * POST /api/bookings
 * A signed-in user requests a rental. The booking starts as pending/unpaid
 * until the Stripe checkout is added; pending reservations still hold stock.
 */
router.post('/', verifyToken, async (request: Request, response: Response) => {
  try {
    const user = request.user!;
    const customerId = toObjectId(user.id);
    if (!customerId) {
      response.status(401).json({ error: 'Invalid user id.' });
      return;
    }

    const body = request.body ?? {};
    const equipmentId = toObjectId(text(body.equipmentId));
    const start = text(body.startDate);
    const end = text(body.endDate);
    const quantity = Number(body.quantity);
    const contact = text(body.contact);
    const address = text(body.address);
    const notes = text(body.notes);

    if (!equipmentId) {
      return badRequest(response, 'equipmentId', 'Choose a valid listing.');
    }
    if (!isIsoDate(start)) {
      return badRequest(response, 'startDate', 'Choose a valid start date.');
    }
    if (!isIsoDate(end)) {
      return badRequest(response, 'endDate', 'Choose a valid end date.');
    }
    if (end < start) {
      return badRequest(response, 'endDate', 'The end date cannot be before the start date.');
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      return badRequest(response, 'quantity', 'Quantity must be a whole number above zero.');
    }
    if (start < todayIso()) {
      return badRequest(response, 'startDate', 'The start date cannot be in the past.');
    }
    if (!contact) {
      return badRequest(response, 'contact', 'A contact number is required.');
    }
    if (!address) {
      return badRequest(response, 'address', 'A delivery address is required.');
    }

    const db = getDb();
    const equipment = await db.collection('equipment').findOne({ _id: equipmentId });
    if (!equipment || equipment.status !== 'approved') {
      response.status(404).json({ error: 'This listing is not available.' });
      return;
    }

    if (String(equipment.ownerId) === String(customerId)) {
      response.status(400).json({ error: 'You cannot book your own equipment.' });
      return;
    }

    const quantityOnListing = Number(equipment.quantity ?? 0);
    if (quantity > quantityOnListing) {
      return badRequest(
        response,
        'quantity',
        `Only ${quantityOnListing} unit${quantityOnListing === 1 ? '' : 's'} available on this listing.`,
      );
    }

    const startDate = asDate(start);
    const endDate = asDate(end);
    const reserved = await reservedUnits(equipmentId, startDate, endDate);
    if (reserved + quantity > quantityOnListing) {
      response.status(409).json({
        error: `Only ${Math.max(0, quantityOnListing - reserved)} unit${
          quantityOnListing - reserved === 1 ? '' : 's'
        } free for those dates. Adjust the dates or quantity.`,
      });
      return;
    }

    const days = Math.max(1, daysBetween(start, end));
    const pricePerDay = Number(equipment.pricePerDay ?? 0);
    const total = pricePerDay * quantity * days;
    const now = new Date();
    const bookingRef = await nextBookingRef();

    const booking = {
      bookingRef,
      customerId,
      ownerId: equipment.ownerId,
      ownerSlug: equipment.ownerSlug ?? '',
      equipmentId,
      equipmentSlug: equipment.slug ?? '',
      startDate,
      endDate,
      quantity,
      total,
      paymentStatus: 'unpaid',
      bookingStatus: 'pending',
      createdAt: now,
      updatedAt: now,
      contact,
      address,
      notes,
    };

    const result = await db.collection('bookings').insertOne(booking);
    const [enriched] = await enrichBookings([
      { ...booking, _id: result.insertedId } as Document,
    ]);

    response.status(201).json({ item: enriched });
  } catch (error) {
    console.error('Failed to create booking:', error);
    serverError(response, 'Failed to create the booking request.');
  }
});

/**
 * GET /api/bookings/mine
 * Bookings made by the signed-in customer with status counts.
 */
router.get('/mine', verifyToken, verifyRenter, async (request: Request, response: Response) => {
  try {
    const user = request.user!;
    const customerId = toObjectId(user.id);
    if (!customerId) {
      response.status(401).json({ error: 'Invalid user id.' });
      return;
    }

    const status = statusClause(request);
    if (status === '__invalid__') {
      return badRequest(response, 'status', 'Unknown booking status.');
    }

    const filter: Filter<Document> = { customerId };
    if (status) filter.bookingStatus = status;

    const rows = await getDb()
      .collection('bookings')
      .find(filter)
      .sort({ startDate: -1 })
      .toArray();

    const [countRows, items] = await Promise.all([
      getDb()
        .collection('bookings')
        .find({ customerId })
        .project({ bookingStatus: 1 })
        .toArray(),
      enrichBookings(rows),
    ]);

    response.json({ items, counts: bookingCounts(countRows) });
  } catch (error) {
    console.error('Failed to load customer bookings:', error);
    serverError(response, 'Failed to load your rentals.');
  }
});

/**
 * GET /api/bookings
 * Owners see bookings for their own equipment; admins see every booking.
 */
router.get('/', verifyToken, async (request: Request, response: Response) => {
  try {
    const user = request.user!;
    if (user.role !== 'owner' && user.role !== 'admin') {
      response.status(403).json({ error: 'This view needs owner or admin access.' });
      return;
    }

    const status = statusClause(request);
    if (status === '__invalid__') {
      return badRequest(response, 'status', 'Unknown booking status.');
    }

    const scope: Filter<Document> = {};
    if (user.role === 'owner') {
      const ownerId = toObjectId(user.id);
      if (!ownerId) {
        response.status(401).json({ error: 'Invalid user id.' });
        return;
      }
      scope.ownerId = ownerId;
    }

    const q = queryText(request.query.q);
    if (q) {
      const term = regexTerm(q);
      scope.$or = [
        { bookingRef: term },
        { contact: term },
        { address: term },
        { notes: term },
        { equipmentSlug: term },
      ];
    }

    const filter: Filter<Document> = { ...scope };
    if (status) filter.bookingStatus = status;

    const { page, limit, skip } = pagination(request, 20, 100);
    const collection = getDb().collection('bookings');
    const [total, rows, countRows] = await Promise.all([
      collection.countDocuments(filter),
      collection.find(filter).sort({ startDate: -1 }).skip(skip).limit(limit).toArray(),
      collection.find(scope).project({ bookingStatus: 1 }).toArray(),
    ]);

    const items = await enrichBookings(rows);

    response.json({
      items,
      counts: bookingCounts(countRows),
      total,
      page,
      perPage: limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error('Failed to load bookings:', error);
    serverError(response, 'Failed to load bookings.');
  }
});

/**
 * POST /api/bookings/:id/checkout
 * The renter starts Stripe Checkout only after the owner confirmed the dates.
 * The amount always comes from the stored booking, never from the request.
 */
router.post(
  '/:id/checkout',
  verifyToken,
  verifyRenter,
  async (request: Request, response: Response) => {
    try {
      const user = request.user!;
      const customerId = toObjectId(user.id);
      const bookingId = toObjectId(uidParam(request));
      if (!customerId) {
        response.status(401).json({ error: 'Invalid user id.' });
        return;
      }
      if (!bookingId) {
        response.status(404).json({ error: 'Booking not found.' });
        return;
      }

      const booking = await getDb()
        .collection('bookings')
        .findOne({ _id: bookingId, customerId });
      if (!booking) {
        response.status(404).json({ error: 'Booking not found.' });
        return;
      }
      if (booking.bookingStatus !== 'upcoming') {
        response.status(409).json({
          error: 'The owner must confirm your booking before you can pay.',
        });
        return;
      }
      if (!['unpaid', 'pending', 'failed'].includes(String(booking.paymentStatus))) {
        response.status(409).json({ error: 'This booking is already paid.' });
        return;
      }

      const checkout = await createBookingCheckout(booking, user.email);
      response.json({ url: checkout.url, sessionId: checkout.sessionId });
    } catch (error) {
      console.error('Failed to create Stripe Checkout session:', error);
      serverError(response, 'Could not start Stripe Checkout. Try again.');
    }
  },
);

/**
 * PATCH /api/bookings/:id
 * Owners move their bookings through fulfilment; customers may cancel.
 */
router.patch('/:id', verifyToken, async (request: Request, response: Response) => {
  try {
    const user = request.user!;
    const userId = toObjectId(user.id);
    const bookingId = toObjectId(uidParam(request));
    if (!userId) {
      response.status(401).json({ error: 'Invalid user id.' });
      return;
    }
    if (!bookingId) {
      response.status(404).json({ error: 'Booking not found.' });
      return;
    }

    const collection = getDb().collection('bookings');
    const booking = await collection.findOne({ _id: bookingId });
    if (!booking) {
      response.status(404).json({ error: 'Booking not found.' });
      return;
    }

    const isAdmin = user.role === 'admin';
    const isOwner = String(booking.ownerId) === String(userId);
    const isCustomer = String(booking.customerId) === String(userId);

    if (!isAdmin && !isOwner && !isCustomer) {
      response.status(403).json({ error: 'You cannot change this booking.' });
      return;
    }

    const body = request.body ?? {};
    const update: Record<string, unknown> = {};

    if ('bookingStatus' in body) {
      const bookingStatus = text(body.bookingStatus);
      if (!BOOKING_STATUSES.has(bookingStatus)) {
        return badRequest(response, 'bookingStatus', 'Unknown booking status.');
      }

      if (isCustomer && !isAdmin && !isOwner) {
        if (bookingStatus !== 'cancelled') {
          response.status(403).json({
            error: 'Customers can only cancel their own booking requests.',
          });
          return;
        }
        if (!['pending', 'upcoming'].includes(String(booking.bookingStatus))) {
          response.status(409).json({
            error: 'Only pending or upcoming bookings can be cancelled.',
          });
          return;
        }
      }
      update.bookingStatus = bookingStatus;
    }

    if ('paymentStatus' in body) {
      if (!isAdmin) {
        response.status(403).json({
          error: 'Only an admin can change a payment status.',
        });
        return;
      }
      const paymentStatus = text(body.paymentStatus);
      if (!PAYMENT_STATUSES.has(paymentStatus)) {
        return badRequest(response, 'paymentStatus', 'Unknown payment status.');
      }
      update.paymentStatus = paymentStatus;
    }

    if (Object.keys(update).length === 0) {
      return badRequest(response, 'body', 'Nothing to update.');
    }

    if (
      update.bookingStatus === 'cancelled' &&
      booking.paymentStatus === 'paid' &&
      !('paymentStatus' in update)
    ) {
      const refund = await refundBookingPayment(bookingId);
      if (!refund.ok) {
        response.status(502).json({
          error: refund.error ?? 'Stripe could not refund this payment.',
        });
        return;
      }
      update.paymentStatus = 'refunded';
    }

    update.updatedAt = new Date();
    await collection.updateOne({ _id: bookingId }, { $set: update });
    const saved = await collection.findOne({ _id: bookingId });
    const [enriched] = saved ? await enrichBookings([saved]) : [null];

    if (
      update.bookingStatus === 'completed' &&
      String(booking.bookingStatus) !== 'completed' &&
      saved
    ) {
      void notifyBookingCompleted([saved]);
    }

    response.json({ item: enriched });
  } catch (error) {
    console.error('Failed to update booking:', error);
    serverError(response, 'Failed to update the booking.');
  }
});

export default router;
