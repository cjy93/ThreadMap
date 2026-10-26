// Black-box checks against a deployed ThreadMap URL; appends nonsecret results
// to reports/cloud-deployment.json. With OWNER_EMAIL/OWNER_PASSWORD it also
// snapshots the owner's chats, counts and logical node diameters so a later
// phase (after Endpoint restart) can prove they are reconstructed identically.
// Usage: node scripts/cloud-verify.mjs <url> <endpoint_id> <image> <region> <preset> [--phase name]
import crypto from 'node:crypto';
import fs from 'node:fs';

const [url, endpointId, image, region, preset] = process.argv.slice(2);
const phase = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : 'verify';
if (!url?.startsWith('https://') && !process.env.ALLOW_HTTP_VERIFY) throw new Error('url must be the observed https:// origin');
const origin = new URL(url).origin;

const jar = new Map();
const cookieHeader = (name) => (jar.get(name) ?? []).join('; ');
async function req(name, path, init = {}) {
  const headers = { ...(init.headers ?? {}), cookie: cookieHeader(name) };
  if (init.method && init.method !== 'GET') headers.origin ??= origin;
  const r = await fetch(origin + path, { ...init, headers, redirect: 'manual' });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) jar.set(name, [...(jar.get(name) ?? []).filter((c) => !set.some((s) => s.split('=')[0] === c.split('=')[0])), ...set.map((s) => s.split(';')[0])]);
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, body };
}

const checks = [];
const check = (id, pass, detail = {}) => checks.push({ id, result: pass ? 'PASS' : 'FAIL', ...detail });

const live = await req('anon', '/api/health/live');
check('health_live', live.status === 200);
const ready = await req('anon', '/api/health/ready');
check('health_ready_content_free', ready.status === 200 && ready.body?.ready === true, { checks: ready.body?.checks });
check('private_route_requires_auth', (await req('anon', '/api/chats')).status === 401);
const spoof = await req('anon', '/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' }, body: JSON.stringify({ email: 'x@example.test', password: 'x'.repeat(12) }) });
check('untrusted_origin_rejected', spoof.status === 403, { status: spoof.status });

const anon = await req('demo', '/api/auth/sign-in/anonymous', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('demo_sign_in', anon.status === 200);
const demoChats = await req('demo', '/api/chats');
const counts = (demoChats.body?.chats ?? []).map((c) => c.message_count).sort((a, b) => a - b);
check('demo_isolated_synthetic_workspace', JSON.stringify(counts) === JSON.stringify([80, 100, 120]), { counts });
check('demo_cannot_pair', (await req('demo', '/api/whatsapp/pair', { method: 'POST' })).status === 403);
check('demo_cannot_view_qr', (await req('demo', '/api/whatsapp/qr')).status === 403);

let snapshot = null;
if (process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD) {
  const s = await req('owner', '/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD }) });
  check('owner_sign_in', s.status === 200);
  const st = await req('owner', '/api/whatsapp/status');
  const chats = (await req('owner', '/api/chats')).body?.chats ?? [];
  const maps = [];
  for (const c of chats) {
    const m = (await req('owner', `/api/chats/${c.id}/map?status=all&max_topic_depth=all`)).body;
    const pref = (await req('owner', `/api/chats/${c.id}/view-preferences`)).body;
    maps.push({
      chat: crypto.createHash('sha256').update(c.id).digest('hex').slice(0, 12),
      messages: c.message_count,
      missed: c.missed_count,
      max_depth: m?.available_max_topic_depth,
      saved_depth: pref?.show_depth,
      nodes: (m?.nodes ?? []).map((n) => [n.id.slice(0, 8), n.matching_message_count, n.matching_missed_count, Number(n.diameter?.toFixed(4))]),
    });
  }
  snapshot = {
    connection_state: st.body?.connection?.state,
    lease_held: st.body?.connection?.lease_held,
    analysis: st.body?.analysis,
    chats: maps.map(({ nodes, ...rest }) => ({ ...rest, node_count: nodes.length })),
    digest: crypto.createHash('sha256').update(JSON.stringify(maps)).digest('hex'),
  };
}

fs.mkdirSync('reports', { recursive: true });
// Local rehearsals must not write the cloud report.
const p = process.env.VERIFY_REPORT ?? 'reports/cloud-deployment.json';
const prev = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
prev.endpoint = { id: endpointId || null, url: origin, image: image || null, region: region || null, preset: preset || null };
prev.phases = { ...(prev.phases ?? {}), [phase]: { at: new Date().toISOString(), checks, owner_snapshot: snapshot } };
if (prev.phases['before-restart']?.owner_snapshot && prev.phases['after-restart']?.owner_snapshot) {
  prev.restart_reconstruction = prev.phases['before-restart'].owner_snapshot.digest === prev.phases['after-restart'].owner_snapshot.digest ? 'PASS: identical counts and logical sizes after restart' : 'FAIL: snapshot differs after restart';
}
fs.writeFileSync(p, JSON.stringify(prev, null, 2));
console.log(JSON.stringify({ phase, checks, snapshot_digest: snapshot?.digest ?? null }, null, 2));
if (checks.some((c) => c.result === 'FAIL')) process.exitCode = 1;
