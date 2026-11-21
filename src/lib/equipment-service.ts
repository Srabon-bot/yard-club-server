import { ObjectId, type Document } from 'mongodb';
import { getDb } from '../db.js';
import { serialize, toApi } from './ids.js';

const HOLD_STATUSES = ['pending', 'upcoming', 'active'];

export type ApiUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  phone: string;
  image: string;
  address: string;
  bio: string;
  initials: string;
  joined: string;
  slug: string;
};

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'YC';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function slugFor(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function toApiUser(user: Document): ApiUser {
  const name = String(user.name ?? 'Yardclub user');
  return {
    id: String(user._id),
    name,
    email: String(user.email ?? ''),
    role: String(user.role ?? 'customer'),
    phone: String(user.phone ?? ''),
    image: String(user.image ?? ''),
    address: String(user.address ?? ''),
    bio: String(user.bio ?? ''),
    initials: initialsFor(name),
    joined: serialize(user.createdAt ?? new Date()),
    slug: slugFor(name),
  };
}

export function todayRange(): { start: Date; end: Date } {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * Units of each listing that are committed for a date window. Pending,
 * upcoming and active bookings all reserve stock so two customers cannot
 * request the same unit at the same time.
 */
export async function heldUnits(
  equipmentIds: ObjectId[],
  start: Date,
  end: Date,
): Promise<Map<string, number>> {
  const held = new Map<string, number>();
  if (equipmentIds.length === 0) return held;

  const rows = await getDb()
    .collection('bookings')
    .aggregate<{ _id: ObjectId; quantity: number }>([
      {
        $match: {
          equipmentId: { $in: equipmentIds },
          bookingStatus: { $in: HOLD_STATUSES },
          startDate: { $lte: end },
          endDate: { $gte: start },
        },
      },
      { $group: { _id: '$equipmentId', quantity: { $sum: '$quantity' } } },
    ])
    .toArray();

  for (const row of rows) {
    held.set(String(row._id), row.quantity);
  }
  return held;
}

export type AvailabilityRow = {
  id: string;
  quantity: number;
  availableNow: boolean;
  heldUnits: number;
};

export async function availabilityFor(
  items: Document[],
): Promise<Map<string, AvailabilityRow>> {
  const range = todayRange();
  const ids = items
    .map((item) => item._id)
    .filter((id): id is ObjectId => Boolean(id));
  const held = await heldUnits(ids, range.start, range.end);

  const result = new Map<string, AvailabilityRow>();
  for (const item of items) {
    const id = String(item._id);
    const quantity = Number(item.quantity ?? 0);
    const heldCount = held.get(id) ?? 0;
    result.set(id, {
      id,
      quantity,
      heldUnits: heldCount,
      availableNow: quantity - heldCount > 0,
    });
  }
  return result;
}

export async function ownerMap(
  items: Document[],
): Promise<Map<string, ApiUser>> {
  const ids = [
    ...new Set(
      items
        .map((item) => item.ownerId)
        .filter((id): id is ObjectId => Boolean(id))
        .map((id) => String(id)),
    ),
  ];

  if (ids.length === 0) return new Map();

  const owners = await getDb()
    .collection('user')
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } })
    .toArray();

  return new Map(owners.map((owner) => [String(owner._id), toApiUser(owner)]));
}

/** Adds `owner` and `availableNow` to an equipment document. */
export function decorateEquipment(
  item: Document,
  owner: ApiUser | undefined,
  availability: AvailabilityRow | undefined,
): Record<string, unknown> {
  return {
    ...toApi(item),
    owner: owner ?? null,
    availableNow: availability?.availableNow ?? Number(item.quantity ?? 0) > 0,
    heldUnits: availability?.heldUnits ?? 0,
  };
}

export async function decorateEquipmentList(
  items: Document[],
): Promise<Record<string, unknown>[]> {
  const [owners, availability] = await Promise.all([
    ownerMap(items),
    availabilityFor(items),
  ]);

  return items.map((item) =>
    decorateEquipment(
      item,
      owners.get(String(item.ownerId)),
      availability.get(String(item._id)),
    ),
  );
}

export async function enrichBookings(
  bookings: Document[],
): Promise<Record<string, unknown>[]> {
  const db = getDb();
  const equipmentIds = bookings
    .map((booking) => booking.equipmentId)
    .filter(Boolean);
  const userIds = [
    ...new Set(
      bookings
        .flatMap((booking) => [booking.customerId, booking.ownerId])
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  ];

  const [equipmentDocs, userDocs] = await Promise.all([
    equipmentIds.length
      ? db.collection('equipment').find({ _id: { $in: equipmentIds } }).toArray()
      : Promise.resolve([]),
    userIds.length
      ? db
          .collection('user')
          .find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } })
          .toArray()
      : Promise.resolve([]),
  ]);

  const equipment = new Map(
    equipmentDocs.map((item) => [String(item._id), toApi(item)]),
  );
  const users = new Map(userDocs.map((user) => [String(user._id), toApiUser(user)]));

  return bookings.map((booking) => ({
    ...toApi(booking),
    equipment: equipment.get(String(booking.equipmentId)) ?? null,
    customer: users.get(String(booking.customerId)) ?? null,
    owner: users.get(String(booking.ownerId)) ?? null,
  }));
}

export function bookingCounts(rows: { bookingStatus?: unknown }[]) {
  const counts: Record<string, number> = {
    all: rows.length,
    pending: 0,
    upcoming: 0,
    active: 0,
    completed: 0,
    cancelled: 0,
  };

  for (const row of rows) {
    const status = String(row.bookingStatus ?? '');
    if (status in counts) counts[status] += 1;
  }
  return counts;
}

export { HOLD_STATUSES };
