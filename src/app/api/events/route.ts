import { requireUser } from '@/server/auth';
import { subscribe } from '@/server/events-hub';
import { errorResponse } from '@/server/http';

export const dynamic = 'force-dynamic';

// Authenticated SSE of content-free change notices for this workspace only.
// Clients refetch authorized state by version; this is never the source of truth.
export async function GET(req: Request) {
  let ctx: Awaited<ReturnType<typeof requireUser>>;
  try {
    ctx = await requireUser(req);
  } catch (e) {
    return errorResponse(e);
  }
  const enc = new TextEncoder();
  let unsub: (() => void) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    unsub?.();
    if (ping) clearInterval(ping);
  };
  const stream = new ReadableStream({
    async start(controller) {
      const write = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          cleanup();
        }
      };
      write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
      unsub = await subscribe(ctx.workspaceId, (ev) => {
        const d = ev.data as { userId?: string };
        // Review notices are per user; QR notices only for the private owner.
        if (d.userId && d.userId !== ctx.userId) return;
        if (ev.type === 'qr' && ctx.mode !== 'private') return;
        write(`event: ${ev.type}\ndata: ${JSON.stringify({ ...d, userId: undefined })}\n\n`);
      });
      ping = setInterval(() => write(': ping\n\n'), 20_000);
      req.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel: cleanup,
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  });
}
