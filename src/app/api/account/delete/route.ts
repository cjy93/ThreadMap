import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { deleteMyAccount } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

export const POST = authed(async (ctx) => deleteMyAccount(getDb(), ctx));
