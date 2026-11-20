import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db.js';
import { idFilter, slugify } from '../lib/ids.js';
import type { RequestUser } from '../types/user.js';

const ROLES = new Set<RequestUser['role']>(['customer', 'owner', 'admin']);

function internalKeyIsValid(request: Request): boolean {
  const configured = process.env.API_INTERNAL_KEY;
  if (!configured) return false;
  return request.get('x-internal-key') === configured;
}

/**
 * Temporary bridge until the JWT middleware lands. The Next.js server calls
 * this API with the signed-in user's id and a shared server-only key. The
 * browser never sees either header.
 */
export async function loadUser(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  if (!process.env.API_INTERNAL_KEY) {
    response.status(500).json({
      error: 'API_INTERNAL_KEY is not configured on the server.',
    });
    return;
  }

  if (!internalKeyIsValid(request)) {
    response.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  const userId = request.get('x-user-id');
  if (!userId) {
    response.status(401).json({ error: 'No user context on this request.' });
    return;
  }

  try {
    const user = await getDb()
      .collection('user')
      .findOne({ _id: idFilter(userId) as never });

    if (!user) {
      response.status(401).json({ error: 'User not found.' });
      return;
    }

    const role = ROLES.has(user.role as RequestUser['role'])
      ? (user.role as RequestUser['role'])
      : 'customer';

    request.user = {
      id: String(user._id),
      role,
      name: String(user.name ?? 'Yardclub user'),
      email: String(user.email ?? ''),
      slug: slugify(String(user.name ?? user.email ?? '')),
    };

    next();
  } catch (error) {
    console.error('Failed to load request user:', error);
    response.status(500).json({ error: 'Failed to load the signed-in user.' });
  }
}

export function requireRole(...roles: RequestUser['role'][]) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.user) {
      response.status(401).json({ error: 'Unauthorized.' });
      return;
    }

    if (!roles.includes(request.user.role)) {
      response.status(403).json({
        error: `This action needs ${roles.join(' or ')} access.`,
      });
      return;
    }

    next();
  };
}
