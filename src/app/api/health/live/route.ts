export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
