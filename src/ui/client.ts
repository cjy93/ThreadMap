'use client';
import { createAuthClient } from 'better-auth/react';
import { anonymousClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({ plugins: [anonymousClient()] });

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    credentials: 'same-origin',
    headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(body.message ?? `Request failed (${res.status})`, res.status, body.error ?? 'error');
  return body as T;
}

export interface FilterState {
  status: 'all' | 'missed' | 'read';
  from?: string;
  to?: string;
  tz: string;
  topics: string[];
}

export function filterParams(f: FilterState): Record<string, string> {
  const p: Record<string, string> = { status: f.status, tz: f.tz };
  if (f.from) p.from = f.from;
  if (f.to) p.to = f.to;
  if (f.topics.length) p.topics = f.topics.join(',');
  return p;
}

export const qs = (o: Record<string, string | undefined>) =>
  new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string>).toString();
