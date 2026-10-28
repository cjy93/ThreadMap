import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { findAnswers } from '@/server/api/answers';

export const dynamic = 'force-dynamic';

// Nemotron reads the message's discussion (once) for answers given without WhatsApp's Reply.
export const POST = authed<{ id: string }>(async (ctx, _req, p) => findAnswers(getDb(), ctx, p.id));
