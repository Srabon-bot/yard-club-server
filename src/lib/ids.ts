import { ObjectId } from 'mongodb';

/** Accepts a 24-character ObjectId string from a route or session. */
export function toObjectId(value: string): ObjectId | null {
  if (!ObjectId.isValid(value)) return null;
  return new ObjectId(value);
}

/** Converts ObjectIds and dates into values that can be sent as JSON. */
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
export function toApi<T extends { _id?: unknown }>(
  document: T,
): Omit<T, '_id'> & { id: string } {
  const { _id, ...rest } = document;
  return { ...serialize(rest), id: _id ? String(_id) : '' };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
