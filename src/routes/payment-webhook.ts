import { Router, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { getStripe } from '../lib/stripe.js';
import {
  finalizePaidBooking,
  markCheckoutSessionFailed,
  markPaymentIntentFailed,
  markPaymentRefunded,
} from '../services/payment-service.js';

const router = Router();

type RawBodyRequest = Request & { rawBody?: unknown };

/**
 * Express gives a Buffer locally; Vercel may expose rawBody as a string (or
 * base64-encoded string). Every candidate is signature-checked, so trying
 * alternatives never bypasses Stripe verification.
 */
function webhookPayloads(request: Request): (Buffer | string)[] {
  const rawBody = (request as RawBodyRequest).rawBody;
  const candidates: unknown[] = [request.body, rawBody];
  const payloads: (Buffer | string)[] = [];

  for (const candidate of candidates) {
    if (Buffer.isBuffer(candidate) || typeof candidate === 'string') {
      payloads.push(candidate);
    }
  }
  if (typeof rawBody === 'string' && /^[A-Za-z0-9+/=\r\n]+$/.test(rawBody)) {
    try {
      payloads.push(Buffer.from(rawBody, 'base64'));
    } catch {
      // Not base64; the original string candidates are still tried.
    }
  }
  return payloads;
}

function refundIntentId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' ? id : '';
  }
  return '';
}

/**
 * POST /api/payments/webhook
 * Mounted with express.raw() before express.json() so Stripe can verify the
 * signature against the exact bytes it signed.
 */
router.post('/', async (request: Request, response: Response) => {
  const signature = request.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const payloads = webhookPayloads(request);

  if (!signature || !webhookSecret || payloads.length === 0) {
    response.status(400).json({ error: 'Missing Stripe webhook signature.' });
    return;
  }

  let event: Stripe.Event | undefined;
  for (const payload of payloads) {
    try {
      event = getStripe().webhooks.constructEvent(
        payload,
        signature,
        webhookSecret,
      );
      break;
    } catch {
      // Try the next raw-body representation.
    }
  }
  if (!event) {
    console.warn('Rejected Stripe webhook: invalid signature.');
    response.status(400).json({ error: 'Invalid Stripe signature.' });
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const result = await finalizePaidBooking(
          event.data.object as Stripe.Checkout.Session,
        );
        if (!result.ok) {
          console.error('Stripe payment was not finalized:', result.error);
        }
        break;
      }
      case 'checkout.session.expired':
        await markCheckoutSessionFailed(
          event.data.object as Stripe.Checkout.Session,
        );
        break;
      case 'payment_intent.payment_failed':
        await markPaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
        break;
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        await markPaymentRefunded({
          paymentIntentId: refundIntentId(charge.payment_intent),
          refundId: String(charge.refunds?.data?.[0]?.id ?? ''),
          amount: Number(charge.amount_refunded ?? 0),
          full: charge.refunded,
        });
        break;
      }
      case 'refund.created':
      case 'refund.updated': {
        const refund = event.data.object as Stripe.Refund;
        await markPaymentRefunded({
          paymentIntentId: refundIntentId(refund.payment_intent),
          refundId: refund.id,
          amount: Number(refund.amount ?? 0),
        });
        break;
      }
      default:
        break;
    }

    response.json({ received: true });
  } catch (error) {
    console.error('Failed to process Stripe webhook:', error);
    response.status(500).json({ error: 'Webhook processing failed.' });
  }
});

export default router;
