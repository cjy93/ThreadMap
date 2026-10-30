import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { findTrail } from '@/server/api/trail';

export const dynamic = 'force-dynamic';

// The saved trail of a message's discussion through the chat (no model call).
export const GET = authed<{ id: string }>(async (ctx, _req, p) => findTrail(getDb(), ctx, p.id, { follow: false }));
// Nemotron follows the discussion forward through the chat until it is resolved.
export const POST = authed<{ id: string }>(async (ctx, _req, p) => findTrail(getDb(), ctx, p.id, { follow: true }));
