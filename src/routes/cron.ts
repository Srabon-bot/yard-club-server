import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { serverError } from '../lib/http.js';
import { sweepBookingStatuses } from '../services/booking-status.js';

const router = Router();

function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * GET /api/cron/booking-sweep
 * Serverless replacement for the local node-cron task. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; x-cron-secret is accepted as well.
 */
router.get('/booking-sweep', async (request: Request, response: Response) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    response.status(503).json({ error: 'Cron is not configured.' });
    return;
  }

  const authorization = request.get('authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';
  const provided = [bearer, request.get('x-cron-secret') ?? ''].filter(Boolean);
  if (provided.length === 0 || !provided.some((value) => secretsMatch(value, expected))) {
    response.status(401).json({ error: 'Unauthorized cron request.' });
    return;
  }

  try {
    const result = await sweepBookingStatuses();
    response.json({ ok: true, ...result });
  } catch (error) {
    console.error('Booking status sweep failed:', error);
    serverError(response, 'Failed to sweep booking statuses.');
  }
});

export default router;
