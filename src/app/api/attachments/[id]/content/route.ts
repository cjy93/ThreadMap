import { attachmentContent } from '@/server/api/connector';
import { requireUser } from '@/server/auth';
import { getDb } from '@/server/db';
import { errorResponse } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, route: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser(req);
    const { id } = await route.params;
    return await attachmentContent(getDb(), ctx, id, new URL(req.url).searchParams.get('download') === '1');
  } catch (e) {
    return errorResponse(e);
  }
}
