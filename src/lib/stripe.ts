import Stripe from 'stripe';

const STRIPE_TIMEOUT_MS = 10_000;

let stripe: Stripe | undefined;

/**
 * Single Stripe client for the Express server. The secret key is read lazily so
 * the API can still answer non-payment routes when it is not configured.
 */
export function getStripe(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured.');
  }

  if (!stripe) {
    stripe = new Stripe(secretKey, { timeout: STRIPE_TIMEOUT_MS });
  }
  return stripe;
}
