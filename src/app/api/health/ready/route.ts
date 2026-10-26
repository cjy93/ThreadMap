import { readiness } from '@/server/health';
import { json } from '@/server/http';

export const dynamic = 'force-dynamic';

// Content-free readiness: component booleans only, never data or secrets.
export async function GET() {
  const r = await readiness();
  return json(r, r.ready ? 200 : 503);
}
