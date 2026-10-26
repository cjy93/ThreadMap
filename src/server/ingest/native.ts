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
}

function chatMeta(c: ChatLike): NormalizedEvent | null {
  const jid = bareJid(c.id);
  if (!jid || isStatusJid(jid)) return null;
  const kind = isGroupJid(jid) ? 'group' : 'direct';
  const alt = kind === 'direct' ? bareJid(jid.endsWith('@lid') ? c.pnJid : c.lidJid) : null;
  return { type: 'chat_meta', chatJid: jid, chatJidAlt: alt, kind, title: c.name ?? c.subject ?? null };
}

export function nativeToNormalized(event: string, data: unknown): NormalizedEvent[] {
  switch (event) {
    case 'chats.upsert':
    case 'chats.update':
    case 'groups.upsert':
    case 'groups.update':
      return ((data as ChatLike[]) ?? []).map(chatMeta).filter((e): e is NormalizedEvent => e !== null);
    case 'messaging-history.set': {
      const d = data as { chats?: ChatLike[]; messages?: WAMessage[]; lidPnMappings?: { pn: string; lid: string }[] };
      const out: NormalizedEvent[] = [];
      for (const m of d.lidPnMappings ?? []) out.push({ type: 'alias', pn: m.pn, lid: m.lid });
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
