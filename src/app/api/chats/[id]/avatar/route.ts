import { avatarContent } from '@/server/api/connector';
import { requireUser } from '@/server/auth';
import { getDb } from '@/server/db';
import { errorResponse } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, route: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser(req);
    const { id } = await route.params;
    return await avatarContent(getDb(), ctx, id);
  } catch (e) {
    return errorResponse(e);
  }
}
