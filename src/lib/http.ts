import type { Request, Response } from 'express';

/** Express 5 exposes query values as strings, arrays or parsed objects. */
export function queryText(value: unknown): string {
  if (Array.isArray(value)) return queryText(value[0]);
  if (typeof value === 'string') return value.trim();
  return '';
}

export function queryNumber(value: unknown): number | undefined {
  const raw = queryText(value).replace(/[^\d.-]/g, '');
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function queryInt(value: unknown): number | undefined {
  const parsed = queryNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

export function queryBoolean(value: unknown): boolean {
  const raw = queryText(value).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export type Pagination = {
  page: number;
  limit: number;
  skip: number;
};

export function pagination(
  request: Request,
  defaultLimit = 9,
  maxLimit = 60,
): Pagination {
  const page = Math.max(1, queryInt(request.query.page) ?? 1);
  const requested = queryInt(request.query.limit) ?? defaultLimit;
  const limit = Math.min(maxLimit, Math.max(1, requested));
  return { page, limit, skip: (page - 1) * limit };
}

export function badRequest(
  response: Response,
  field: string,
  message: string,
): void {
  response.status(400).json({ error: message, field });
}

export function notFound(response: Response, message = 'Not found.'): void {
  response.status(404).json({ error: message });
}

export function serverError(response: Response, message: string): void {
  response.status(500).json({ error: message });
}

/** Escapes a user search term before it becomes a MongoDB regex. */
export function regexTerm(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  const from = new Date(`${start}T00:00:00.000Z`).getTime();
  const to = new Date(`${end}T00:00:00.000Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

export function uidParam(request: Request, name = 'id'): string {
  const raw = request.params[name];
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
}
