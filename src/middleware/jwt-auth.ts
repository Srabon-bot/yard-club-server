import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ObjectId, type Document } from 'mongodb';
import { getDb } from '../db.js';
import { slugify, toObjectId } from '../lib/ids.js';
import type { RequestUser } from '../types/user.js';

const ROLES = new Set<RequestUser['role']>(['customer', 'owner', 'admin']);

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Better Auth base URL; the JWKS lives under /api/auth/jwks. */
function clientUrl(): string {
  return (
    process.env.CLIENT_URL ||
    process.env.BETTER_AUTH_URL ||
    'http://localhost:3000'
  ).replace(/\/+$/, '');
}

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${clientUrl()}/api/auth/jwks`));
  }
  return jwks;
}

function roleFrom(value: unknown): RequestUser['role'] {
  return ROLES.has(value as RequestUser['role'])
    ? (value as RequestUser['role'])
    : 'customer';
}

function bearerToken(request: Request): string {
  const authorization = request.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return '';
  return authorization.slice('Bearer '.length).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A valid JWT proves identity, but the backend still reads the latest user
 * record. Missing users are created from the token so the two databases stay
 * in sync; the stored role always wins over the token's role.
 */
async function resolveUser(payload: JWTPayload): Promise<Document | null> {
  const collection = getDb().collection('user');
  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  const email =
    typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';

  const subjectId = subject ? toObjectId(subject) : null;
  if (subjectId) {
    const byId = await collection.findOne({ _id: subjectId });
    if (byId) return byId;
  }

  if (!email) return null;

  const byEmail = await collection.findOne({ email });
  if (byEmail) return byEmail;

  const caseInsensitiveEmail = await collection.findOne({
    email: { $regex: new RegExp(`^${escapeRegExp(email)}$`, 'i') },
  });
  if (caseInsensitiveEmail) return caseInsensitiveEmail;

  const name =
    typeof payload.name === 'string' && payload.name.trim()
      ? payload.name.trim()
      : email.split('@')[0];
  const now = new Date();
  const user: Document = {
    _id: new ObjectId(),
    name,
    email,
    emailVerified: false,
    image: null,
    role: roleFrom(payload.role),
    phone: '',
    createdAt: now,
    updatedAt: now,
  };

  await collection.insertOne(user);
  return user;
}

/**
 * Verifies the Better Auth JWT against the JWKS endpoint, syncs the matching
 * user from MongoDB, and attaches the authoritative record to `request.user`.
 */
export async function verifyToken(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearerToken(request);
  if (!token) {
    response.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, getJwks(), {
      issuer: clientUrl(),
      audience: clientUrl(),
    });
    payload = result.payload;
  } catch (error) {
    console.warn(
      'Rejected JWT:',
      error instanceof Error ? error.message : 'verification failed',
    );
    response.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }

  try {
    const user = await resolveUser(payload);
    if (!user) {
      response.status(401).json({ error: 'User not found.' });
      return;
    }

    if (user.status === 'suspended') {
      response.status(403).json({ error: 'This account is suspended.' });
      return;
    }

    request.user = {
      id: String(user._id),
      role: roleFrom(user.role),
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

function roleGuard(label: string, ...roles: RequestUser['role'][]) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.user) {
      response.status(401).json({ error: 'Unauthorized.' });
      return;
    }

    if (!roles.includes(request.user.role)) {
      response.status(403).json({ error: `${label} access required.` });
      return;
    }

    next();
  };
}

/** Renters are the `customer` role in Yardclub. */
export const verifyRenter = roleGuard('Renter', 'customer');

export const verifyOwner = roleGuard('Owner', 'owner');

export const verifyAdmin = roleGuard('Admin', 'admin');

/** Owner and admin dashboards share listing management endpoints. */
export const verifyOwnerOrAdmin = roleGuard('Owner or admin', 'owner', 'admin');
