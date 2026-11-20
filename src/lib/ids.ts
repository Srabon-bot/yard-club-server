import { ObjectId } from 'mongodb';

/** Accepts either a 24-character ObjectId string or a plain string id. */
export function toObjectId(value: string): ObjectId | null {
  if (!ObjectId.isValid(value)) return null;
  return new ObjectId(value);
}

/**
 * Mongo documents in this project were seeded with a mix of ObjectId and
 * string ids. Query with both shapes until the seed data is normalised.
 */
export function idFilter(value: string): Record<string, unknown> {
  const objectId = toObjectId(value);
  return objectId ? { $in: [objectId, value] } : { $in: [value] };
}

export function idsEqual(
  left: unknown,
  right: unknown,
): boolean {
  if (left == null || right == null) return false;
  return String(left) === String(right);
}

/** Recursively converts ObjectIds and Dates into JSON-safe values. */
export function serialize<T>(value: T): T {
  if (value instanceof ObjectId) return value.toHexString() as T;
  if (value instanceof Date) return value.toISOString() as T;
  if (Array.isArray(value)) return value.map((entry) => serialize(entry)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        serialize(entry),
      ]),
    ) as T;
  }
  return value;
}

/** Adds a string `id` field and removes Mongo's `_id` from an API response. */
export function toApi<T extends { _id: unknown }>(
  document: T,
): Omit<T, '_id'> & { id: string } {
  const { _id, ...rest } = document;
  return { ...serialize(rest), id: String(_id) };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
