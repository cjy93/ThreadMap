import QRCode from 'qrcode';
import { requireOwner, requireUser } from '@/server/auth';
import { currentQr } from '@/server/events-hub';
import { errorResponse, json } from '@/server/http';

export const dynamic = 'force-dynamic';

// Owner-only, transient and uncached. The QR string is never logged or persisted.
export async function GET(req: Request) {
  try {
    const ctx = await requireUser(req);
    requireOwner(ctx);
    const qr = currentQr(ctx.workspaceId);
    if (!qr) return json({ available: false });
    return json({ available: true, image: await QRCode.toDataURL(qr, { margin: 1, width: 280 }) });
  } catch (e) {
    return errorResponse(e);
  }
}
