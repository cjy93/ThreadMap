import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { discoveredChats } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

export const GET = authed(async (ctx) => discoveredChats(getDb(), ctx));
