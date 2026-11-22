import type Stripe from 'stripe';
import type { Document, Filter } from 'mongodb';
import { getDb } from '../db.js';
import { getStripe } from '../lib/stripe.js';
import { toObjectId } from '../lib/ids.js';

type CheckoutResult = { url: string; sessionId: string };

type FinalizeResult = {
  ok: boolean;
  bookingId?: string;
  alreadyRecorded?: boolean;
  error?: string;
};

type RefundResult = { ok: boolean; refunded?: boolean; error?: string };

let indexesReady: Promise<void> | undefined;

/** Unique payment records make webhook + success-page writes idempotent. */
export function ensurePaymentIndexes(): Promise<void> {
  if (!indexesReady) {
    indexesReady = getDb()
      .collection('payments')
      .createIndexes([
        {
          key: { stripeSessionId: 1 },
          name: 'uniq_stripe_session',
          unique: true,
          sparse: true,
        },
        {
          key: { paymentIntentId: 1 },
          name: 'uniq_payment_intent',
          unique: true,
          sparse: true,
        },
        { key: { bookingId: 1 }, name: 'idx_payment_booking' },
      ])
      .then(() => undefined)
      .catch((error: unknown) => {
        indexesReady = undefined;
        throw error;
      });
  }
  return indexesReady;
}

function clientUrl(): string {
  return (
    process.env.CLIENT_URL ||
    process.env.BETTER_AUTH_URL ||
    'http://localhost:3000'
  ).replace(/\/+$/, '');
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isoDate(value: unknown): string {
  const date = new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

/** Metadata travels to both the Session and its PaymentIntent. */
export function bookingMetadata(booking: Document): Record<string, string> {
  return {
    bookingId: String(booking._id),
    bookingRef: String(booking.bookingRef ?? ''),
    customerId: String(booking.customerId ?? ''),
    ownerId: String(booking.ownerId ?? ''),
    equipmentId: String(booking.equipmentId ?? ''),
  };
}

/**
 * Creates a hosted Stripe Checkout session from the booking stored in Mongo.
 * No amount or identity is accepted from the browser.
 */
export async function createBookingCheckout(
  booking: Document,
  customerEmail: string,
): Promise<CheckoutResult> {
  await ensurePaymentIndexes();
  const stripe = getStripe();
  const bookingId = String(booking._id);

  // A second click while Checkout is still open should reuse the same session.
  const openSessionId = asText(booking.stripeSessionId);
  if (booking.paymentStatus === 'pending' && openSessionId) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(openSessionId);
      if (existing.status === 'open' && existing.url) {
        return { url: existing.url, sessionId: existing.id };
      }
    } catch {
      // An expired or invalid session simply gets replaced below.
    }
  }

  const total = Number(booking.total ?? 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('This booking does not have a payable total.');
  }

  const amount = Math.round(total * 100); // BDT major units -> poisha.
  const metadata = bookingMetadata(booking);
  const dates = `${isoDate(booking.startDate)} → ${isoDate(booking.endDate)}`;
  const updatedAt =
    booking.updatedAt instanceof Date
      ? booking.updatedAt.getTime()
      : Number(booking.updatedAt) || Date.now();

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'bdt',
            unit_amount: amount,
            product_data: {
              name: `Yardclub rental ${booking.bookingRef ?? bookingId}`,
              description: `${asText(booking.equipmentSlug) || 'Equipment'} · ${dates} · ${Number(booking.quantity ?? 1)} unit(s)`,
            },
          },
        },
      ],
      client_reference_id: bookingId,
      customer_email: asText(customerEmail) || undefined,
      metadata,
      payment_intent_data: { metadata },
      success_url: `${clientUrl()}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl()}/payment-cancelled?booking=${encodeURIComponent(bookingId)}`,
    },
    {
      idempotencyKey: `yc-checkout-${bookingId}-${Number.isFinite(updatedAt) ? updatedAt : 0}`,
    },
  );

  if (!session.url) {
    throw new Error('Stripe did not return a Checkout URL.');
  }

  await getDb().collection('bookings').updateOne(
    { _id: booking._id },
    {
      $set: {
        stripeSessionId: session.id,
        paymentStatus: 'pending',
        updatedAt: new Date(),
      },
    },
  );

  return { url: session.url, sessionId: session.id };
}

function bookingIdFromSession(
  session: Stripe.Checkout.Session,
): ReturnType<typeof toObjectId> {
  const id = asText(session.metadata?.bookingId) || asText(session.client_reference_id);
  return toObjectId(id);
}

function paymentIntentId(
  source: Stripe.Checkout.Session | Stripe.PaymentIntent,
): string {
  if (!('payment_intent' in source)) return asText(source.id);
  const value = source.payment_intent;
  return asText(typeof value === 'string' ? value : value?.id);
}

async function findBookingById(id: NonNullable<ReturnType<typeof toObjectId>>) {
  return getDb().collection('bookings').findOne({ _id: id });
}

async function setBookingPaymentStatus(
  bookingId: NonNullable<ReturnType<typeof toObjectId>>,
  status: string,
  extra: Document = {},
) {
  await getDb().collection('bookings').updateOne(
    { _id: bookingId, paymentStatus: 'pending' },
    { $set: { paymentStatus: status, updatedAt: new Date(), ...extra } },
  );
}

/**
 * Writes the payments record and marks the booking paid. Safe to call from
 * both the webhook and the success page; unique indexes stop duplicates.
 */
export async function finalizePaidBooking(
  session: Stripe.Checkout.Session,
): Promise<FinalizeResult> {
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    return { ok: false, error: 'The Checkout session is not paid.' };
  }

  const bookingId = bookingIdFromSession(session);
  if (!bookingId) {
    return { ok: false, error: 'The Checkout session has no booking reference.' };
  }

  await ensurePaymentIndexes();
  const bookings = getDb().collection('bookings');
  const payments = getDb().collection('payments');
  const booking = await findBookingById(bookingId);
  if (!booking) {
    return { ok: false, error: 'The booking for this payment was not found.' };
  }

  const intentId = paymentIntentId(session);
  const amount = Number(booking.total ?? 0);
  const expectedMinor = Math.round(amount * 100);
  if (
    typeof session.amount_total === 'number' &&
    session.amount_total !== expectedMinor
  ) {
    console.warn(
      `Stripe amount mismatch for ${String(booking.bookingRef ?? bookingId)}: ` +
        `charged ${session.amount_total}, booking total ${expectedMinor}.`,
    );
  }

  const now = new Date();
  const existing = await payments.findOne({ stripeSessionId: session.id });
  const alreadyRecorded = Boolean(existing);

  if (!existing) {
    const record: Document = {
      bookingId,
      bookingRef: String(booking.bookingRef ?? ''),
      customerId: booking.customerId,
      ownerId: booking.ownerId,
      equipmentId: booking.equipmentId,
      stripeSessionId: session.id,
      ...(intentId ? { paymentIntentId: intentId } : {}),
      amount,
      currency: asText(session.currency).toLowerCase() || 'bdt',
      status: 'paid',
      paidAt: now,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await payments.insertOne(record);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  } else if (existing.status !== 'paid') {
    await payments.updateOne(
      { _id: existing._id },
      { $set: { status: 'paid', paidAt: now, ...(intentId ? { paymentIntentId: intentId } : {}), updatedAt: now } },
    );
  }

  await bookings.updateOne(
    { _id: bookingId },
    {
      $set: {
        paymentStatus: 'paid',
        stripeSessionId: session.id,
        ...(intentId ? { paymentIntentId: intentId } : {}),
        paidAt: now,
        updatedAt: now,
      },
    },
  );

  // A renter can cancel while Checkout is still open. If payment lands after
  // that, refund it immediately instead of leaving a paid cancelled booking.
  if (booking.bookingStatus === 'cancelled' && intentId) {
    try {
      const refund = await getStripe().refunds.create({
        payment_intent: intentId,
        reason: 'requested_by_customer',
      });
      await payments.updateOne(
        { stripeSessionId: session.id },
        {
          $set: {
            status: 'refunded',
            refundId: refund.id,
            refundedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );
      await bookings.updateOne(
        { _id: bookingId },
        { $set: { paymentStatus: 'refunded', updatedAt: new Date() } },
      );
    } catch (error) {
      console.error('Automatic refund after cancelled Checkout failed:', error);
    }
  }

  return { ok: true, bookingId: String(bookingId), alreadyRecorded };
}

async function recordFailedPayment(
  match: Filter<Document>,
  fields: Document,
) {
  const payments = getDb().collection('payments');
  await ensurePaymentIndexes();
  const existing = await payments.findOne(match);
  const now = new Date();

  if (existing) {
    if (existing.status !== 'paid') {
      await payments.updateOne(
        { _id: existing._id },
        { $set: { ...fields, status: 'failed', updatedAt: now } },
      );
    }
    return;
  }

  try {
    await payments.insertOne({
      ...fields,
      status: 'failed',
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
}

/** An abandoned Checkout session leaves the booking ready for a retry. */
export async function markCheckoutSessionFailed(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const bookingId = bookingIdFromSession(session);
  if (!bookingId) return;

  const booking = await findBookingById(bookingId);
  const now = new Date();
  await setBookingPaymentStatus(bookingId, 'failed');

  await recordFailedPayment(
    { stripeSessionId: session.id },
    {
      bookingId,
      bookingRef: String(booking?.bookingRef ?? session.metadata?.bookingRef ?? ''),
      customerId: booking?.customerId,
      ownerId: booking?.ownerId,
      equipmentId: booking?.equipmentId,
      stripeSessionId: session.id,
      amount: Number(booking?.total ?? (session.amount_total ?? 0) / 100),
      currency: asText(session.currency).toLowerCase() || 'bdt',
      failedAt: now,
    },
  );
}

/** A declined card is recorded against the PaymentIntent's metadata. */
export async function markPaymentIntentFailed(
  intent: Stripe.PaymentIntent,
): Promise<void> {
  const metadataBookingId = asText(intent.metadata?.bookingId);
  const existingPayment = metadataBookingId
    ? null
    : await getDb()
        .collection('payments')
        .findOne({ paymentIntentId: intent.id });

  const bookingId = toObjectId(
    metadataBookingId || String(existingPayment?.bookingId ?? ''),
  );
  if (!bookingId) return;

  const booking = await findBookingById(bookingId);
  const now = new Date();
  await setBookingPaymentStatus(bookingId, 'failed');

  await recordFailedPayment(
    { paymentIntentId: intent.id },
    {
      bookingId,
      bookingRef: String(booking?.bookingRef ?? intent.metadata?.bookingRef ?? ''),
      customerId: booking?.customerId,
      ownerId: booking?.ownerId,
      equipmentId: booking?.equipmentId,
      paymentIntentId: intent.id,
      amount: Number(booking?.total ?? intent.amount / 100),
      currency: asText(intent.currency).toLowerCase() || 'bdt',
      failedAt: now,
    },
  );
}

/** Refunds the captured Stripe charge when a paid booking is cancelled. */
export async function refundBookingPayment(
  bookingId: NonNullable<ReturnType<typeof toObjectId>>,
): Promise<RefundResult> {
  await ensurePaymentIndexes();
  const payments = getDb().collection('payments');
  const payment = await payments.findOne({ bookingId, status: 'paid' });

  // Legacy/admin-marked bookings have no Stripe record to refund.
  if (!payment || !asText(payment.paymentIntentId)) {
    return { ok: true, refunded: false };
  }

  try {
    const refund = await getStripe().refunds.create({
      payment_intent: asText(payment.paymentIntentId),
      reason: 'requested_by_customer',
    });

    await payments.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: 'refunded',
          refundId: refund.id,
          refundedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );
    return { ok: true, refunded: true };
  } catch (error) {
    console.error('Stripe refund failed:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Stripe refund failed.',
    };
  }
}
