// Deterministic generator for native-shaped (Baileys 7 event payload) fixture
// events plus an independently computed expected manifest.
import crypto from 'node:crypto';
import { CHATS, DEEP, FILLER, PEOPLE, THREADS, UPDATE_20, type ChatKey, type FileSpec, type LineOpts } from './spec';

export const FIXTURE_VERSION = 'threadmap-fixtures-v1';

export interface NativeEvent {
  event: string;
  data: unknown;
}

export interface ManifestMessage {
  nativeId: string;
  chat: ChatKey;
  ref?: string;
  speaker: string;
  fromMe: boolean;
  text: string;
  topic: string; // topic key chat:path
  also: string[];
  discussion: string; // discussion key
  file?: FileSpec;
  urls: string[];
  eligible: boolean;
  phase: 'initial' | 'late' | 'update';
}

export interface ManifestTopic {
  key: string;
  chat: ChatKey;
  root: 'KNOWLEDGE' | 'GENERAL_CHAT' | 'RESOURCES';
  path: string;
  title: string;
  parentKey: string | null;
  depth: number;
}

export interface Manifest {
  version: string;
  chats: Record<ChatKey, { jid: string; title: string; kind: string; expectedHuman: number }>;
  topics: ManifestTopic[];
  discussions: { key: string; chat: ChatKey; topicKey: string; title: string }[];
  messages: ManifestMessage[];
  expectedCounts: Record<string, number>;
  deepPath: string[];
  totals: { human: number; files: number; urls: number; perChat: Record<ChatKey, number> };
  refs: Record<string, string>;
  scenarios: Record<string, { description: string; refs: string[] }>;
}

const ROOT_OF: Record<string, ManifestTopic['root']> = { K: 'KNOWLEDGE', G: 'GENERAL_CHAT', R: 'RESOURCES' };
const ROOT_TITLE: Record<string, string> = { K: 'Knowledge', G: 'General Chat', R: 'Resources' };
const BASE_TIME = Date.UTC(2026, 8, 1, 1, 0, 0) / 1000; // 2026-09-01T01:00Z
const UPDATE_TIME = Date.UTC(2026, 9, 20, 2, 0, 0) / 1000; // 2026-10-20T02:00Z

const h = (s: string) => crypto.createHash('sha256').update(s).digest('hex').toUpperCase();
const nativeIdFor = (chat: ChatKey, seq: string, fromMe: boolean) => (fromMe ? `3EB0${h(`${chat}:${seq}`).slice(0, 16)}` : h(`${chat}:${seq}`).slice(0, 20));
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gu;

// Tiny deterministic file bodies; the content is synthetic and harmless.
export function fixtureFileBytes(f: FileSpec): Buffer | null {
  if (f.availability !== 'cached') return null;
  if (f.mime === 'application/pdf') {
    const text = `ThreadMap synthetic fixture file: ${f.name}`;
    const stream = `BT /F1 12 Tf 40 760 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(body.length);
      body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = body.length;
    body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(body, 'latin1');
  }
  if (f.mime === 'image/png') {
    // 1x1 PNG pixel
    return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  }
  return Buffer.from(`ThreadMap synthetic fixture file: ${f.name}\nThis text stands in for a shared document.\n`, 'utf8');
}

function topicKey(chat: ChatKey, path: string) {
  return `${chat}:${path}`;
}

export function generateFixtures() {
  const topics = new Map<string, ManifestTopic>();
  const ensureTopic = (chat: ChatKey, path: string) => {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      const key = topicKey(chat, p);
      if (topics.has(key)) continue;
      topics.set(key, {
        key,
        chat,
        root: ROOT_OF[parts[0]],
        path: p,
        title: i === 1 ? ROOT_TITLE[parts[0]] : parts[i - 1],
        parentKey: i === 1 ? null : topicKey(chat, parts.slice(0, i - 1).join('/')),
        depth: i - 1,
      });
    }
    return topicKey(chat, path);
  };
  for (const c of Object.keys(CHATS) as ChatKey[]) for (const r of ['K', 'G', 'R']) ensureTopic(c, r);

  const discussions = new Map<string, { key: string; chat: ChatKey; topicKey: string; title: string }>();
  const ensureDiscussion = (chat: ChatKey, topic: string, title: string) => {
    const key = `${chat}:${topic}#${title}`;
    if (!discussions.has(key)) discussions.set(key, { key, chat, topicKey: topicKey(chat, topic), title });
    return key;
  };

  const messages: ManifestMessage[] = [];
  const refs: Record<string, string> = {};
  const seq: Record<ChatKey, number> = { builders: 0, study: 0, music: 0 };

  const addLine = (chat: ChatKey, topic: string, discussion: string, speaker: string, text: string, opts: LineOpts = {}, phase: ManifestMessage['phase'] = 'initial') => {
    const fromMe = speaker === 'me';
    const n = seq[chat]++;
    const nativeId = nativeIdFor(chat, `${phase}:${n}`, fromMe);
    const tk = ensureTopic(chat, topic);
    const m: ManifestMessage = {
      nativeId,
      chat,
      ref: opts.ref,
      speaker,
      fromMe,
      text,
      topic: tk,
      also: (opts.also ?? []).map((a) => ensureTopic(chat, a)),
      discussion: ensureDiscussion(chat, topic, discussion),
      file: opts.file,
      urls: [...text.matchAll(URL_RE)].map((x) => x[0]),
      eligible: true,
      phase,
    };
    messages.push(m);
    if (opts.ref) refs[opts.ref] = nativeId;
    return m;
  };

  // Interleave threads per chat (round robin) so discussions overlap in time.
  for (const chat of Object.keys(CHATS) as ChatKey[]) {
    const threads = THREADS.filter((t) => t.chat === chat).map((t) => ({ t, i: 0 }));
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const th of threads) {
        if (th.i < th.t.lines.length) {
          const [speaker, text, opts] = th.t.lines[th.i++];
          addLine(chat, th.t.topic, th.t.discussion, speaker, text, opts);
          progressed = true;
        }
      }
    }
  }

  // The "late" message arrives after an out-of-order edit (counts as human).
  const late = addLine('builders', 'K/Programming/Hackathons/Tips', 'Hackathon tips', 'wei', 'Tip: keep a printed copy of the demo script.', { ref: 'late-edited' }, 'late');

  // Fill to the per-chat target with grounded filler chatter.
  for (const chat of Object.keys(CHATS) as ChatKey[]) {
    const have = messages.filter((m) => m.chat === chat && m.eligible).length;
    const need = CHATS[chat].targetHuman - have;
    if (need < 0) throw new Error(`${chat} has ${have} authored messages, above target ${CHATS[chat].targetHuman}`);
    const pools = FILLER[chat];
    const members = CHATS[chat].members;
    for (let i = 0; i < need; i++) {
      const pool = pools[i % pools.length];
      const line = pool.lines[Math.floor(i / pools.length) % pool.lines.length];
      const speaker = members[(i * 7 + 3) % members.length];
      addLine(chat, pool.topic, pool.discussion, speaker, line);
    }
  }

  const updates = UPDATE_20.map((u) => addLine(u.chat, u.topic, u.discussion, u.speaker, u.text, {}, 'update'));

  // ------------------------------------------------------------------ events
  const time = new Map<string, number>();
  const ordered = { builders: [] as ManifestMessage[], study: [] as ManifestMessage[], music: [] as ManifestMessage[] };
  for (const m of messages) ordered[m.chat].push(m);
  for (const chat of Object.keys(ordered) as ChatKey[]) {
    let tInit = BASE_TIME + (chat === 'study' ? 600 : chat === 'music' ? 1200 : 0);
    let tUpd = UPDATE_TIME + (chat === 'study' ? 300 : 0);
    for (const m of ordered[chat]) {
      if (m.phase === 'update') {
        time.set(m.nativeId, tUpd);
        tUpd += 45;
      } else {
        time.set(m.nativeId, tInit);
        tInit += 37 * 60;
      }
    }
  }

  const participantJid = (chat: ChatKey, speaker: string, phase: ManifestMessage['phase']) => {
    const p = PEOPLE[speaker];
    // Sara is first observed by LID only; her PN is learned later via lid-mapping.
    if (speaker === 'sara') return phase === 'update' ? { participant: p.pn } : { participant: p.lid };
    return { participant: p.lid, participantAlt: p.pn };
  };

  const waMessage = (m: ManifestMessage) => {
    const chat = CHATS[m.chat];
    const key: Record<string, unknown> = { remoteJid: chat.jid, fromMe: m.fromMe, id: m.nativeId };
    if (chat.kind === 'group' && !m.fromMe) Object.assign(key, participantJid(m.chat, m.speaker, m.phase));
    let message: Record<string, unknown>;
    if (m.file) {
      const field = m.file.kind === 'image' ? 'imageMessage' : m.file.kind === 'audio' ? 'audioMessage' : m.file.kind === 'video' ? 'videoMessage' : 'documentMessage';
      const bytes = fixtureFileBytes(m.file);
      message = {
        [field]: {
          mimetype: m.file.mime,
          fileName: m.file.kind === 'document' ? m.file.name : undefined,
          caption: m.text,
          fileLength: bytes?.length ?? 48_000,
          mediaKey: Buffer.from(h(`mk:${m.nativeId}`).slice(0, 32), 'hex').toString('base64'),
          directPath: `/v/t62.fixture/${m.nativeId}`,
          url: `https://mmg.whatsapp.net/fixture/${m.nativeId}`,
        },
      };
    } else if (m.urls.length || m.ref === 'refresh-q') {
      message = { extendedTextMessage: { text: m.text } };
    } else {
      message = { conversation: m.text };
    }
    return {
      key,
      messageTimestamp: time.get(m.nativeId),
      pushName: m.fromMe ? undefined : PEOPLE[m.speaker].name,
      message,
    };
  };

  const initialMsgs = messages.filter((m) => m.phase === 'initial');
  const extras: Record<ChatKey, unknown[]> = { builders: [], study: [], music: [] };
  // Non-human / non-eligible records mixed into history.
  const xid = (s: string) => h(`extra:${s}`).slice(0, 20);
  extras.builders.push(
    { key: { remoteJid: CHATS.builders.jid, fromMe: false, id: xid('stub'), participant: PEOPLE.alex.lid }, messageTimestamp: BASE_TIME + 5, messageStubType: 27, messageStubParameters: [PEOPLE.sara.lid] },
    { key: { remoteJid: CHATS.builders.jid, fromMe: false, id: xid('loc'), participant: PEOPLE.priya.lid, participantAlt: PEOPLE.priya.pn }, messageTimestamp: BASE_TIME + 9000, pushName: PEOPLE.priya.name, message: { locationMessage: { degreesLatitude: 1.3, degreesLongitude: 103.8 } } },
    { key: { remoteJid: CHATS.builders.jid, fromMe: false, id: xid('viewonce'), participant: PEOPLE.wei.lid, participantAlt: PEOPLE.wei.pn }, messageTimestamp: BASE_TIME + 9500, pushName: PEOPLE.wei.name, message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg', caption: 'view once' } } } } },
    { key: { remoteJid: CHATS.builders.jid, fromMe: false, id: xid('reaction'), participant: PEOPLE.alex.lid }, messageTimestamp: BASE_TIME + 9600, message: { reactionMessage: { key: { id: refs['refresh-1'] }, text: '👍' } } },
  );
  extras.study.push({ key: { remoteJid: CHATS.study.jid, fromMe: false, id: xid('poll'), participant: PEOPLE.omar.lid, participantAlt: PEOPLE.omar.pn }, messageTimestamp: BASE_TIME + 20000, pushName: PEOPLE.omar.name, message: { pollCreationMessageV3: { name: 'Best study day?', options: [{ optionName: 'Thu' }, { optionName: 'Fri' }] } } });
  // A disappearing message (7 days) sent long ago: already expired on load.
  extras.music.push({
    key: { remoteJid: CHATS.music.jid, fromMe: false, id: xid('ephemeral') },
    messageTimestamp: BASE_TIME + 100,
    pushName: PEOPLE.mei.name,
    message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'This disappearing note should not be indexed after expiry.', contextInfo: { expiration: 604800 } } } } },
  });

  const discover: NativeEvent[] = [
    {
      event: 'chats.upsert',
      data: (Object.keys(CHATS) as ChatKey[]).map((c) => ({ id: CHATS[c].jid, name: CHATS[c].title, conversationTimestamp: BASE_TIME })),
    },
    {
      event: 'chats.upsert',
      // An unselected chat: its content must never be stored.
      data: [{ id: '120363000000000099@g.us', name: 'Family (unselected)', conversationTimestamp: BASE_TIME }],
    },
  ];

  const historyBatches: NativeEvent[] = [];
  for (const chat of Object.keys(CHATS) as ChatKey[]) {
    const msgs = [...initialMsgs.filter((m) => m.chat === chat).map(waMessage), ...extras[chat]];
    for (let i = 0; i < msgs.length; i += 50) {
      historyBatches.push({ event: 'messaging-history.set', data: { chats: [], contacts: [], messages: msgs.slice(i, i + 50), isLatest: false, progress: null, syncType: 2 } });
    }
  }
  const unselectedHistory: NativeEvent = {
    event: 'messaging-history.set',
    data: {
      chats: [],
      contacts: [],
      messages: [
        { key: { remoteJid: '120363000000000099@g.us', fromMe: false, id: xid('family-1'), participant: PEOPLE.omar.lid }, messageTimestamp: BASE_TIME + 50, pushName: 'Relative', message: { conversation: 'PRIVATE-UNSELECTED-CANARY dinner at 7?' } },
      ],
      isLatest: false,
      syncType: 2,
    },
  };

  const byRef = (r: string) => messages.find((m) => m.ref === r)!;
  const duplicateDeliveries: NativeEvent[] = [
    { event: 'messages.upsert', data: { type: 'append', messages: initialMsgs.slice(0, 10).map(waMessage) } },
    { event: 'messages.upsert', data: { type: 'notify', messages: [waMessage(byRef('refresh-1')), waMessage(byRef('refresh-2')), ...initialMsgs.slice(40, 43).map(waMessage)] } },
  ];

  // Out-of-order: edit arrives before its base message; revoke arrives before its base.
  const revokedEarly = { key: { remoteJid: CHATS.builders.jid, fromMe: false, id: xid('revoked-early'), participant: PEOPLE.alex.lid, participantAlt: PEOPLE.alex.pn }, messageTimestamp: BASE_TIME + 30000, pushName: PEOPLE.alex.name, message: { conversation: 'REVOKED-CANARY oops wrong chat' } };
  const outOfOrder: NativeEvent[] = [
    {
      event: 'messages.update',
      data: [{ key: { remoteJid: CHATS.builders.jid, fromMe: false, id: late.nativeId, participant: PEOPLE.wei.lid }, update: { message: { editedMessage: { message: { conversation: 'Tip: keep a printed copy of the demo script and a charged backup phone.' } } }, messageTimestamp: time.get(late.nativeId)! + 120 } }],
    },
    {
      event: 'messages.update',
      data: [{ key: { remoteJid: CHATS.builders.jid, fromMe: false, id: revokedEarly.key.id, participant: PEOPLE.alex.lid }, update: { message: null, messageStubType: 1, key: { remoteJid: CHATS.builders.jid, fromMe: false, id: xid('revoke-msg'), participant: PEOPLE.alex.lid } } }],
    },
    { event: 'messaging-history.set', data: { chats: [], contacts: [], messages: [waMessage(late), revokedEarly], isLatest: true, syncType: 2 } },
    // Receipt-only update: not a content edit.
    { event: 'messages.update', data: [{ key: { remoteJid: CHATS.builders.jid, fromMe: true, id: refs['refresh-q'] }, update: { status: 4 } }] },
    { event: 'lid-mapping.update', data: { pn: PEOPLE.sara.pn, lid: PEOPLE.sara.lid } },
  ];

  const update20: NativeEvent[] = [
    { event: 'messages.upsert', data: { type: 'notify', messages: updates.slice(0, 12).map(waMessage) } },
    { event: 'messages.upsert', data: { type: 'notify', messages: updates.slice(12).map(waMessage) } },
  ];

  // Scenario steps used by tests after the initial load.
  const editDeep: NativeEvent[] = [
    {
      event: 'messages.update',
      data: [
        {
          key: { remoteJid: CHATS.builders.jid, fromMe: false, id: refs['refresh-4'], participant: PEOPLE.alex.lid },
          update: { message: { editedMessage: { message: { conversation: 'Yes, bind the refresh token to the session id and device; reject and alert if the device changed.' } } }, messageTimestamp: time.get(refs['refresh-4'])! + 3600 },
        },
      ],
    },
  ];
  const rubric = messages.find((m) => m.file?.name === 'judging-rubric.pdf')!;
  const revokeFile: NativeEvent[] = [
    { event: 'messages.update', data: [{ key: { remoteJid: CHATS.builders.jid, fromMe: false, id: rubric.nativeId, participant: PEOPLE.sara.lid }, update: { message: null, messageStubType: 1, key: { remoteJid: CHATS.builders.jid, fromMe: false, id: xid('revoke-rubric'), participant: PEOPLE.sara.lid } } }] },
  ];
  const staleReplay: NativeEvent[] = [
    { event: 'messaging-history.set', data: { chats: [], contacts: [], messages: [waMessage(rubric), revokedEarly, waMessage(byRef('refresh-4'))], isLatest: true, syncType: 2 } },
  ];

  // ---------------------------------------------------------------- manifest
  const eligibleInitial = messages.filter((m) => m.phase !== 'update');
  const counts: Record<string, Set<string>> = {};
  const addCount = (tk: string, id: string) => {
    let cur: string | null = tk;
    while (cur) {
      (counts[cur] ??= new Set()).add(id);
      cur = topics.get(cur)!.parentKey;
    }
  };
  for (const m of eligibleInitial) for (const tk of [m.topic, ...m.also]) addCount(tk, m.nativeId);
  const expectedCounts = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.size]));

  const perChat = { builders: 0, study: 0, music: 0 } as Record<ChatKey, number>;
  for (const m of eligibleInitial) perChat[m.chat]++;
  const manifest: Manifest = {
    version: FIXTURE_VERSION,
    chats: Object.fromEntries((Object.keys(CHATS) as ChatKey[]).map((c) => [c, { jid: CHATS[c].jid, title: CHATS[c].title, kind: CHATS[c].kind, expectedHuman: CHATS[c].targetHuman }])) as Manifest['chats'],
    topics: [...topics.values()],
    discussions: [...discussions.values()],
    messages,
    expectedCounts,
    deepPath: ['K', ...Object.values(DEEP).map((p) => p.slice(2))].map((p, i) => (i === 0 ? 'builders:K' : `builders:K/${p}`)),
    totals: {
      human: eligibleInitial.length,
      files: messages.filter((m) => m.file).length,
      urls: messages.reduce((n, m) => n + m.urls.length, 0),
      perChat,
    },
    refs: { ...refs, rubric: rubric.nativeId, 'revoked-early': revokedEarly.key.id, 'unselected-canary': 'PRIVATE-UNSELECTED-CANARY' },
    scenarios: {
      'edit-deep': { description: 'Edit of a six-level-deep source after it was reviewed', refs: ['refresh-4'] },
      'revoke-file': { description: 'Revocation of a message with a cached file', refs: ['rubric'] },
      'stale-replay': { description: 'History replay of revoked/edited messages must not restore old content', refs: ['rubric', 'revoked-early', 'refresh-4'] },
      'update-20': { description: 'Twenty new distinct human messages, incoming and owner-sent', refs: [] },
    },
  };

  const media: Record<string, { b64: string; mime: string } | { availability: 'unavailable' | 'failed' }> = {};
  for (const m of messages) {
    if (!m.file) continue;
    const bytes = fixtureFileBytes(m.file);
    media[m.nativeId] = bytes ? { b64: bytes.toString('base64'), mime: m.file.mime } : { availability: m.file.availability as 'unavailable' | 'failed' };
  }

  return {
    manifest,
    media,
    steps: {
      discover,
      initial: [...historyBatches, unselectedHistory, ...duplicateDeliveries, ...outOfOrder],
      'update-20': update20,
      'edit-deep': editDeep,
      'revoke-file': revokeFile,
      'stale-replay': staleReplay,
    } as Record<string, NativeEvent[]>,
  };
}
