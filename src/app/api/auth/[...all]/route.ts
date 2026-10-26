import { getAuth } from '@/server/auth';
import { json } from '@/server/http';

export const dynamic = 'force-dynamic';

async function handle(req: Request) {
  const auth = await getAuth();
  if (!auth) return json({ error: 'not_ready', message: 'Sign-in is disabled until the deployment origin is bootstrapped' }, 503);
  return auth.handler(req);
}

export const GET = handle;
export const POST = handle;
