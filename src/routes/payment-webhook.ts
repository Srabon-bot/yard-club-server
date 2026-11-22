import { Router, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { getStripe } from '../lib/stripe.js';
import {
  finalizePaidBooking,
  markCheckoutSessionFailed,
  markPaymentIntentFailed,
} from '../services/payment-service.js';

const router = Router();

/**
 * POST /api/payments/webhook
 * Mounted with express.raw() before express.json() so Stripe can verify the
 * signature against the exact bytes it signed.
 */
router.post('/', async (request: Request, response: Response) => {
  const signature = request.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const payload = request.body;

  if (!signature || !webhookSecret || !Buffer.isBuffer(payload)) {
    response.status(400).json({ error: 'Missing Stripe webhook signature.' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      payload,
      signature,
      webhookSecret,
    );
  } catch (error) {
    console.warn(
      'Rejected Stripe webhook:',
      error instanceof Error ? error.message : 'invalid signature',
    );
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
        if (!result.ok) console.warn('Stripe payment not finalized:', result.error);
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
