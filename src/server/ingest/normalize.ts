// Pure conversion from Baileys 7.0.0-rc14 event payload shapes to normalized
// source events. Shapes verified against node_modules/baileys/lib/Types and
// Utils/process-message.js of the pinned release.
import type { proto, WAMessage, WAMessageKey, WAMessageUpdate } from 'baileys';
import type { IngestOrigin, MessageEvent, NormalizedAttachment, NormalizedEvent } from './types';

// proto enum values (WAProto ProtocolMessage.Type) for the pinned release.
const PROTOCOL_REVOKE = 0;
const PROTOCOL_MESSAGE_EDIT = 14;
// WebMessageInfo.StubType.REVOKE
const STUB_REVOKE = 1;

type Longish = number | string | { toNumber(): number } | null | undefined;

export function toNum(v: Longish): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber();
  }
  // protobufjs Long-like {low, high}
  const o = v as unknown as { low?: number; high?: number };
  if (typeof o.low === 'number' && typeof o.high === 'number') return o.high * 2 ** 32 + (o.low >>> 0);
  return null;
}

export const isGroupJid = (jid: string) => jid.endsWith('@g.us');
export const isStatusJid = (jid: string) => jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');

/** Strip the device suffix (user:device@server → user@server). */
export function bareJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const [user, server] = jid.split('@');
  if (!server) return jid;
  return `${user.split(':')[0]}@${server}`;
}

function b64(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return null;
}

interface Unwrapped {
  content: proto.IMessage | null | undefined;
  viewOnce: boolean;
  ephemeralSec: number | null;
}

function unwrap(message: proto.IMessage | null | undefined): Unwrapped {
  let m = message;
  let viewOnce = false;
  let ephemeralSec: number | null = null;
  for (let i = 0; i < 5 && m; i++) {
    if (m.ephemeralMessage?.message) {
      m = m.ephemeralMessage.message;
      continue;
    }
    if (m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message) {
      viewOnce = true;
      m = m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.viewOnceMessageV2Extension?.message;
      continue;
    }
    if (m.documentWithCaptionMessage?.message) {
      m = m.documentWithCaptionMessage.message;
      continue;
    }
    if (m.editedMessage?.message) {
      m = m.editedMessage.message;
      continue;
    }
    break;
  }
  const ctx =
    m?.extendedTextMessage?.contextInfo ??
    m?.imageMessage?.contextInfo ??
    m?.videoMessage?.contextInfo ??
    m?.documentMessage?.contextInfo ??
    m?.audioMessage?.contextInfo;
  const exp = ctx?.expiration;
  if (typeof exp === 'number' && exp > 0) ephemeralSec = exp;
  return { content: m, viewOnce, ephemeralSec };
}

const MEDIA_FIELDS = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
] as const;

const UNSUPPORTED_FIELDS = [
  'locationMessage',
  'liveLocationMessage',
  'contactMessage',
  'contactsArrayMessage',
  'pollCreationMessage',
  'pollCreationMessageV2',
  'pollCreationMessageV3',
  'pollUpdateMessage',
  'eventMessage',
  'groupInviteMessage',
  'productMessage',
  'orderMessage',
  'listMessage',
  'buttonsMessage',
  'templateMessage',
  'interactiveMessage',
  'ptvMessage',
  'albumMessage',
] as const;

function senderOf(key: WAMessageKey, chatJid: string): { senderJid: string; participantJid: string | null; participantAltJid: string | null } {
  const participantJid = bareJid(key.participant);
  const participantAltJid = bareJid(key.participantAlt);
  if (key.fromMe) return { senderJid: 'self', participantJid, participantAltJid };
  if (isGroupJid(chatJid)) return { senderJid: participantJid ?? 'unknown', participantJid, participantAltJid };
  return { senderJid: chatJid, participantJid, participantAltJid };
}

/** Normalize one WAMessage from messages.upsert or messaging-history.set. */
export function normalizeWAMessage(msg: WAMessage, origin: IngestOrigin): NormalizedEvent {
  const key = msg.key;
  const chatJid = bareJid(key?.remoteJid);
  if (!key || !key.id || !chatJid) return { type: 'ignored', reason: 'missing_key' };
  if (isStatusJid(chatJid)) return { type: 'ignored', reason: 'status_or_broadcast' };
  const chatKind = isGroupJid(chatJid) ? 'group' : 'direct';
  const sentAtSec = toNum(msg.messageTimestamp as Longish);
  const fromMe = Boolean(key.fromMe);
  const { senderJid, participantJid, participantAltJid } = senderOf(key, chatJid);
  const { content, viewOnce, ephemeralSec } = unwrap(msg.message);

  // Protocol control messages (edit/revoke) carried inside an upsert/history.
  const pm = content?.protocolMessage;
  if (pm) {
    const target = pm.key?.id;
    const type = toNum(pm.type as Longish);
    if (target && type === PROTOCOL_REVOKE) {
      return { type: 'revoke', chatJid, eventKey: `revoke:${key.id}`, targetNativeId: target, fromMe: Boolean(pm.key?.fromMe ?? fromMe), timeSec: sentAtSec };
    }
    if (target && type === PROTOCOL_MESSAGE_EDIT) {
      const body = textOf(unwrap(pm.editedMessage).content);
      if (body !== null) {
        const tms = toNum(pm.timestampMs as Longish);
        return {
          type: 'edit',
          chatJid,
          eventKey: `edit:${key.id}`,
          targetNativeId: target,
          fromMe: Boolean(pm.key?.fromMe ?? fromMe),
          newBody: body,
          editTimeSec: tms !== null ? Math.floor(tms / 1000) : sentAtSec,
        };
      }
    }
    return { type: 'ignored', reason: 'protocol_message' };
  }
  if (content?.reactionMessage || content?.senderKeyDistributionMessage && !textOf(content)) {
    return { type: 'ignored', reason: content?.reactionMessage ? 'reaction' : 'key_distribution' };
  }

  const base: Omit<MessageEvent, 'kind' | 'body' | 'attachments' | 'marker'> = {
    type: 'message',
    origin,
    ...(msg.starred ? { starred: true } : {}),
    chatJid,
    chatJidAlt: bareJid(key.remoteJidAlt),
    chatKind,
    nativeId: key.id,
    fromMe,
    participantJid,
    participantAltJid,
    senderJid,
    senderName: fromMe ? 'You' : (msg.pushName ?? null),
    sentAtSec,
    replyToNativeId: contextOf(content)?.stanzaId ?? null,
    ephemeralSec,
  };

  // Revoked-in-history stubs arrive as messageStubType REVOKE with no content.
  if (toNum(msg.messageStubType as Longish) === STUB_REVOKE) {
    return { type: 'revoke', chatJid, eventKey: `stub-revoke:${key.id}`, targetNativeId: key.id, fromMe, timeSec: sentAtSec };
  }
  if (msg.messageStubType && !content) {
    return { ...base, kind: 'system', body: null, attachments: [], marker: `system:${String(msg.messageStubType)}` };
  }
  if (!content) return { type: 'ignored', reason: 'empty' };

  if (viewOnce) {
    return { ...base, kind: 'unsupported', body: null, attachments: [], marker: 'view_once' };
  }

  for (const [field, mediaType] of MEDIA_FIELDS) {
    const media = content[field] as
      | (proto.Message.IImageMessage & proto.Message.IDocumentMessage & { fileLength?: Longish })
      | null
      | undefined;
    if (media) {
      const att: NormalizedAttachment = {
        mediaType,
        mime: media.mimetype ?? null,
        filename: (media as proto.Message.IDocumentMessage).fileName ?? null,
        size: toNum(media.fileLength as Longish),
        viewOnce: false,
        thumbnailB64: mediaType === 'image' || mediaType === 'video' ? b64((media as proto.Message.IVideoMessage).jpegThumbnail) : null,
        mediaRef: JSON.stringify({
          field,
          mediaKey: b64(media.mediaKey),
          directPath: media.directPath ?? null,
          url: media.url ?? null,
          mimetype: media.mimetype ?? null,
          fileEncSha256: b64(media.fileEncSha256),
          fileSha256: b64(media.fileSha256),
          fileLength: toNum(media.fileLength as Longish),
        }),
      };
      const caption = (media as proto.Message.IImageMessage).caption ?? null;
      return { ...base, kind: 'media', body: caption, attachments: [att], marker: null };
    }
  }

  const text = textOf(content);
  if (text !== null) return { ...base, kind: 'text', body: text, attachments: [], marker: null };

  for (const f of UNSUPPORTED_FIELDS) {
    if (content[f]) return { ...base, kind: 'unsupported', body: null, attachments: [], marker: `unsupported:${f}` };
  }
  return { ...base, kind: 'unsupported', body: null, attachments: [], marker: 'unsupported:unknown' };
}

function contextOf(c: proto.IMessage | null | undefined): proto.IContextInfo | null | undefined {
  return (
    c?.extendedTextMessage?.contextInfo ??
    c?.imageMessage?.contextInfo ??
    c?.videoMessage?.contextInfo ??
    c?.documentMessage?.contextInfo ??
    c?.audioMessage?.contextInfo
  );
}

function textOf(c: proto.IMessage | null | undefined): string | null {
  if (!c) return null;
  if (typeof c.conversation === 'string' && c.conversation.length > 0) return c.conversation;
  if (typeof c.extendedTextMessage?.text === 'string') return c.extendedTextMessage.text;
  return null;
}

/** Normalize one messages.update entry (edits, revocations, receipts). */
export function normalizeMessageUpdate(u: WAMessageUpdate): NormalizedEvent {
  const chatJid = bareJid(u.key?.remoteJid);
  const id = u.key?.id;
  if (!chatJid || !id) return { type: 'ignored', reason: 'missing_key' };
  if (isStatusJid(chatJid)) return { type: 'ignored', reason: 'status_or_broadcast' };
  const upd = u.update ?? {};
  const fromMe = Boolean(u.key.fromMe);
  if (upd.message === null && toNum(upd.messageStubType as Longish) === STUB_REVOKE) {
    // process-message.js: key = {...revokeMessage.key, id: target}; update.key = revoke message key
    const revokeKey = (upd as { key?: WAMessageKey }).key;
    return {
      type: 'revoke',
      chatJid,
      eventKey: `revoke:${revokeKey?.id ?? id}`,
      targetNativeId: id,
      fromMe,
      timeSec: toNum(upd.messageTimestamp as Longish),
    };
  }
  // Starring on the phone syncs as an update carrying only the new star state.
  if (typeof upd.starred === 'boolean') return { type: 'star', chatJid, targetNativeId: id, fromMe, starred: upd.starred };
  const edited = upd.message?.editedMessage?.message;
  if (edited) {
    const body = textOf(unwrap(edited).content) ?? textOf(edited);
    const caption =
      edited.imageMessage?.caption ?? edited.videoMessage?.caption ?? edited.documentMessage?.caption ?? null;
    const newBody = body ?? caption;
    if (newBody !== null) {
      const t = toNum(upd.messageTimestamp as Longish);
      return {
        type: 'edit',
        chatJid,
        eventKey: `edit:${id}:${t ?? 'unknown'}:${hashShort(newBody)}`,
        targetNativeId: id,
        fromMe,
        newBody,
        editTimeSec: t,
      };
    }
  }
  return { type: 'ignored', reason: 'receipt_or_status_update' };
}

/** messages.delete with explicit keys → revocations. */
export function normalizeMessageDelete(e: { keys: WAMessageKey[] } | { jid: string; all: true }): NormalizedEvent[] {
  if ('all' in e) return [{ type: 'ignored', reason: 'chat_clear' }];
  return e.keys.flatMap((k): NormalizedEvent[] => {
    const chatJid = bareJid(k.remoteJid);
    if (!chatJid || !k.id) return [];
    return [{ type: 'revoke', chatJid, eventKey: `delete:${k.id}`, targetNativeId: k.id, fromMe: Boolean(k.fromMe), timeSec: null }];
  });
}

function hashShort(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
