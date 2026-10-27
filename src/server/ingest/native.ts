// Maps Baileys event-emitter payloads (by event name) to normalized events.
// Used identically by the live companion and the fixture replay adapter.
import type { WAMessage, WAMessageUpdate } from 'baileys';
import { bareJid, isGroupJid, isStatusJid, normalizeMessageDelete, normalizeMessageUpdate, normalizeWAMessage } from './normalize';
import type { NormalizedEvent } from './types';

interface ChatLike {
  id?: string | null;
  name?: string | null;
  subject?: string | null;
  pnJid?: string | null;
  lidJid?: string | null;
  conversationTimestamp?: number | { toNumber(): number } | null;
}

const seconds = (v: ChatLike['conversationTimestamp']) => {
  const n = v == null ? NaN : typeof v === 'number' ? v : v.toNumber();
  return Number.isFinite(n) && n > 0 ? n : null;
};

interface ContactLike {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}

function contact(c: ContactLike): NormalizedEvent | null {
  const jid = bareJid(c.id);
  if (!jid || isGroupJid(jid) || isStatusJid(jid)) return null;
  const alt = bareJid(jid.endsWith('@lid') ? c.phoneNumber : c.lid);
  // WhatsApp sometimes sends a (masked) phone number as a "name"; that is not a name.
  const realName = (v: string | null | undefined) => {
    const t = v?.trim();
    return t && !/^\+?[\d\s∙•·-]+$/.test(t) ? t : null;
  };
  const name = realName(c.name);
  const pushName = realName(c.notify) ?? realName(c.verifiedName);
  if (!name && !pushName) return null;
  return { type: 'contact', jid, altJid: alt && alt !== jid ? alt : null, name, pushName };
}

function chatMeta(c: ChatLike): NormalizedEvent | null {
  const jid = bareJid(c.id);
  if (!jid || isStatusJid(jid)) return null;
  const kind = isGroupJid(jid) ? 'group' : 'direct';
  const alt = kind === 'direct' ? bareJid(jid.endsWith('@lid') ? c.pnJid : c.lidJid) : null;
  return { type: 'chat_meta', chatJid: jid, chatJidAlt: alt, kind, title: c.name ?? c.subject ?? null, lastActivitySec: seconds(c.conversationTimestamp) };
}

export function nativeToNormalized(event: string, data: unknown): NormalizedEvent[] {
  switch (event) {
    case 'chats.upsert':
    case 'chats.update':
    case 'groups.upsert':
    case 'groups.update':
      return ((data as ChatLike[]) ?? []).map(chatMeta).filter((e): e is NormalizedEvent => e !== null);
    case 'contacts.upsert':
    case 'contacts.update':
      return ((data as ContactLike[]) ?? []).map(contact).filter((e): e is NormalizedEvent => e !== null);
    case 'messaging-history.set': {
      const d = data as { chats?: ChatLike[]; contacts?: ContactLike[]; messages?: WAMessage[]; lidPnMappings?: { pn: string; lid: string }[] };
      const out: NormalizedEvent[] = [];
      for (const m of d.lidPnMappings ?? []) out.push({ type: 'alias', pn: m.pn, lid: m.lid });
      for (const c of d.contacts ?? []) {
        const e = contact(c);
        if (e) out.push(e);
      }
      for (const c of d.chats ?? []) {
        const e = chatMeta(c);
        if (e) out.push(e);
      }
      for (const m of d.messages ?? []) out.push(normalizeWAMessage(m, 'history'));
      return out;
    }
    case 'messages.upsert': {
      const d = data as { messages: WAMessage[]; type: 'notify' | 'append' };
      // Every message in the batch is processed, including fromMe.
      return d.messages.map((m) => normalizeWAMessage(m, d.type === 'notify' ? 'live' : 'append'));
    }
    case 'messages.update':
      return (data as WAMessageUpdate[]).map(normalizeMessageUpdate);
    case 'messages.delete':
      return normalizeMessageDelete(data as Parameters<typeof normalizeMessageDelete>[0]);
    case 'lid-mapping.update': {
      const d = data as { pn: string; lid: string };
      return [{ type: 'alias', pn: d.pn, lid: d.lid }];
    }
    default:
      return [{ type: 'ignored', reason: event }];
  }
}
