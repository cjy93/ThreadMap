// Cloud-memory-only buffer for history that arrives before the owner selects
// chats. Bounded by bytes and TTL; never persisted, logged or traced.
import type { MessageEvent } from './types';

export interface BufferWarning {
  type: 'preselection_overflow' | 'preselection_expired';
  chatJid: string;
  dropped: number;
}

interface Entry {
  ev: MessageEvent;
  bytes: number;
  at: number;
}

export class PreselectionBuffer {
  private entries: Entry[] = [];
  private bytes = 0;
  readonly warnings: BufferWarning[] = [];

  constructor(
    private readonly maxBytes: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  static estimate(ev: MessageEvent): number {
    return Buffer.byteLength(JSON.stringify(ev), 'utf8');
  }

  get sizeBytes() {
    return this.bytes;
  }
  get count() {
    return this.entries.length;
  }

  add(ev: MessageEvent): boolean {
    this.expire();
    const bytes = PreselectionBuffer.estimate(ev);
    if (this.bytes + bytes > this.maxBytes) {
      this.warn('preselection_overflow', ev.chatJid, 1);
      return false;
    }
    this.entries.push({ ev, bytes, at: this.now() });
    this.bytes += bytes;
    return true;
  }

  /** Remove and return buffered events for chats that are now selected; drop the rest if asked. */
  release(isSelected: (chatJid: string) => boolean): MessageEvent[] {
    this.expire();
    const out: MessageEvent[] = [];
    const keep: Entry[] = [];
    for (const e of this.entries) {
      if (isSelected(e.ev.chatJid)) out.push(e.ev);
      else keep.push(e);
    }
    this.entries = keep;
    this.bytes = keep.reduce((n, e) => n + e.bytes, 0);
    return out;
  }

  /** Discard everything (selection settled, pause, disconnect). */
  clear(): number {
    const n = this.entries.length;
    this.entries = [];
    this.bytes = 0;
    return n;
  }

  expire(): void {
    const cutoff = this.now() - this.ttlMs;
    if (!this.entries.length || this.entries[0].at > cutoff) return;
    const dropped = new Map<string, number>();
    this.entries = this.entries.filter((e) => {
      if (e.at > cutoff) return true;
      dropped.set(e.ev.chatJid, (dropped.get(e.ev.chatJid) ?? 0) + 1);
      return false;
    });
    this.bytes = this.entries.reduce((n, e) => n + e.bytes, 0);
    for (const [chatJid, n] of dropped) this.warn('preselection_expired', chatJid, n);
  }

  private warn(type: BufferWarning['type'], chatJid: string, n: number) {
    const w = this.warnings.find((x) => x.type === type && x.chatJid === chatJid);
    if (w) w.dropped += n;
    else this.warnings.push({ type, chatJid, dropped: n });
  }
}
