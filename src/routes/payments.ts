import { Router, type Request, type Response } from 'express';
import type { Document } from 'mongodb';
import { getDb } from '../db.js';
import { enrichBookings } from '../lib/equipment-service.js';
import { badRequest, serverError, text } from '../lib/http.js';
import { toApi, toObjectId } from '../lib/ids.js';
import { getStripe } from '../lib/stripe.js';
import { verifyRenter, verifyToken } from '../middleware/jwt-auth.js';
import { ensurePaymentIndexes, finalizePaidBooking } from '../services/payment-service.js';

const router = Router();

/**
 * POST /api/payments/verify
 * The success page calls this with Stripe's session id. Nothing is trusted from
 * the URL until the session is retrieved from Stripe and the booking is owned
 * by the signed-in renter.
 */
router.post(
  '/verify',
  verifyToken,
  verifyRenter,
  async (request: Request, response: Response) => {
    try {
      const body = request.body ?? {};
      const sessionId = text(body.sessionId ?? body.session_id);
      const customerId = toObjectId(request.user!.id);

      if (!sessionId.startsWith('cs_') || !customerId) {
        return badRequest(response, 'sessionId', 'A valid Stripe session id is required.');
      }

      const session = await getStripe().checkout.sessions.retrieve(sessionId);
      if (session.status !== 'complete' || session.payment_status !== 'paid') {
        response.status(409).json({ error: 'This payment has not completed.' });
        return;
      }

      const bookingId = toObjectId(
        text(session.metadata?.bookingId) || text(session.client_reference_id),
      );
      if (!bookingId) {
        response.status(400).json({ error: 'The session has no booking reference.' });
        return;
      }

      const booking = await getDb()
        .collection('bookings')
        .findOne({ _id: bookingId, customerId });
      if (!booking) {
        response.status(404).json({ error: 'Booking not found.' });
        return;
      }

      const result = await finalizePaidBooking(session);
      if (!result.ok) {
        response.status(500).json({ error: result.error ?? 'Could not record the payment.' });
        return;
      }

      await ensurePaymentIndexes();
      const [saved, payment] = await Promise.all([
        getDb().collection('bookings').findOne({ _id: bookingId }),
        getDb()
          .collection('payments')
          .findOne({ stripeSessionId: session.id }),
      ]);

      const [item] = saved ? await enrichBookings([saved as Document]) : [null];
      response.json({
        item,
        payment: payment ? toApi(payment) : null,
      });
    } catch (error) {
      console.error('Failed to verify Stripe payment:', error);
      serverError(response, 'Could not verify this payment.');
    }
  },
);

export default router;
