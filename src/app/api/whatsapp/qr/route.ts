import QRCode from 'qrcode';
import { requireOwner, requireUser } from '@/server/auth';
import { currentPairingCode, currentQr } from '@/server/events-hub';
import { errorResponse, json } from '@/server/http';

export const dynamic = 'force-dynamic';

// Owner-only, transient and uncached. The QR string is never logged or persisted.
export async function GET(req: Request) {
  try {
    const ctx = await requireUser(req);
    requireOwner(ctx);
    const qr = currentQr(ctx.workspaceId);
    // A phone-number pairing code, when the owner chose to link without scanning.
    const code = currentPairingCode(ctx.workspaceId);
    if (!qr) return json({ available: false, code });
    return json({ available: true, image: await QRCode.toDataURL(qr, { margin: 1, width: 280 }), code });
  } catch (e) {
    return errorResponse(e);
  }
}
