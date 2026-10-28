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
  /** "Map from": a chat's separate map built from only the owner's ("mine") or the others' messages. */
  side?: 'mine' | 'others';
}

/**
 * A message box whose words can be selected and copied (to look something up),
 * opened by double-click or Enter rather than a single click, which would end
 * every selection by opening the message.
 */
export function openOnDoubleClick(open: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    title: 'Double-click to open. Select words to copy them.',
    onDoubleClick: () => {
      // The double-click also selected a word; opening is what was meant.
      window.getSelection()?.removeAllRanges();
      open();
    },
    onKeyDown: (e: { key: string; target: unknown; currentTarget: unknown; preventDefault: () => void }) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
        e.preventDefault();
        open();
      }
    },
  } as const;
}

export function filterParams(f: FilterState): Record<string, string> {
  const p: Record<string, string> = { status: f.status, tz: f.tz };
  if (f.from) p.from = f.from;
  if (f.to) p.to = f.to;
  if (f.topics.length) p.topics = f.topics.join(',');
  if (f.side) p.side = f.side;
  return p;
}

export const qs = (o: Record<string, string | undefined>) =>
  new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string>).toString();

/**
 * Leaving deletes the account: WhatsApp is unlinked and every chat, message,
 * map and photo is removed. Asks first; returns to the landing page.
 */
export async function leaveAndDeleteAccount(): Promise<void> {
  const ok = window.confirm(
    'Disconnect WhatsApp and delete your ThreadMap data?\n\nYour chat list, stored messages, maps and photos are deleted and ThreadMap is removed from your phone’s Linked Devices. This cannot be undone.',
  );
  if (!ok) return;
  try {
    await api('/api/account/delete', { method: 'POST' });
  } finally {
    await authClient.signOut().catch(() => undefined);
    window.location.assign('/');
  }
}

/** Numbers cited messages across a whole summary: one number per message, in order of first citation. */
export function sourceNumbers(ids: string[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const id of ids) if (!n.has(id)) n.set(id, n.size + 1);
  return n;
}
