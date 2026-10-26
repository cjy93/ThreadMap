// Normalized source events. Both the live Baileys adapter and the fixture
// source produce these from native-shaped events, so persistence logic is the
// same for genuine and replayed input.

export type IngestOrigin = 'live' | 'history' | 'append';

export interface NormalizedAttachment {
  mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  mime: string | null;
  filename: string | null;
  size: number | null;
  viewOnce: boolean;
  /** Serialized native download material; encrypted before storage. */
  mediaRef: string | null;
  /** Fixture-only bytes (base64) standing in for a successful media fetch. */
  fixtureBytesB64?: string;
  /** Fixture-only availability override (e.g. expired media). */
  fixtureAvailability?: 'unavailable' | 'failed';
}

export interface MessageEvent {
  type: 'message';
  origin: IngestOrigin;
  chatJid: string;
  chatJidAlt?: string | null;
  chatKind: 'group' | 'direct';
  nativeId: string;
  fromMe: boolean;
  participantJid: string | null;
  participantAltJid: string | null;
  senderJid: string;
  senderName: string | null;
  /** Native original sent time in seconds, null when unknown. */
  sentAtSec: number | null;
  kind: 'text' | 'media' | 'system' | 'unsupported';
  body: string | null;
  attachments: NormalizedAttachment[];
  replyToNativeId: string | null;
  /** Disappearing-message duration in seconds when known. */
  ephemeralSec: number | null;
  /** Content-free description for system/unsupported markers. */
  marker: string | null;
}

export interface EditEvent {
  type: 'edit';
  chatJid: string;
  eventKey: string;
  targetNativeId: string;
  fromMe: boolean;
  newBody: string;
  editTimeSec: number | null;
}

export interface RevokeEvent {
  type: 'revoke';
  chatJid: string;
  eventKey: string;
  targetNativeId: string;
  fromMe: boolean;
  timeSec: number | null;
}

export interface AliasEvent {
  type: 'alias';
  pn: string;
  lid: string;
}

export interface ChatMetaEvent {
  type: 'chat_meta';
  chatJid: string;
  chatJidAlt?: string | null;
  kind: 'group' | 'direct';
  title: string | null;
}

/** Receipts, presence, reactions and other non-content updates. */
export interface IgnoredEvent {
  type: 'ignored';
  reason: string;
}

export type NormalizedEvent = MessageEvent | EditEvent | RevokeEvent | AliasEvent | ChatMetaEvent | IgnoredEvent;
