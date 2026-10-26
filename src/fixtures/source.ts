// FixtureSourceAdapter: replays committed native-shaped fixture events through
// the same normalizer and ingestion path as the live companion. Results are
// labeled fixture/replay and can never satisfy live-connection gates.
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../server/db';
import { ingestEvents, type IngestContext, type IngestStats } from '../server/ingest/ingest';
import { nativeToNormalized } from '../server/ingest/native';
import type { NormalizedEvent } from '../server/ingest/types';
import type { Manifest, NativeEvent } from './generate';

export const FIXTURE_DIR = path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.FIXTURE_DIR ?? 'fixtures/v1');

export interface FixtureBundle {
  manifest: Manifest;
  media: Record<string, { b64: string; mime: string } | { availability: 'unavailable' | 'failed' }>;
  steps: Record<string, NativeEvent[]>;
}

let cached: FixtureBundle | undefined;
export function loadFixtureBundle(dir = FIXTURE_DIR): FixtureBundle {
  if (cached && dir === FIXTURE_DIR) return cached;
  const read = <T>(f: string): T => JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ path.join(dir, f), 'utf8')) as T;
  const b: FixtureBundle = { manifest: read('manifest.json'), media: read('media.json'), steps: read('events.json') };
  if (dir === FIXTURE_DIR) cached = b;
  return b;
}

export function normalizeFixtureEvents(bundle: FixtureBundle, events: NativeEvent[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const e of events) {
    for (const n of nativeToNormalized(e.event, e.data)) {
      if (n.type === 'message' && n.attachments.length) {
        const media = bundle.media[n.nativeId];
        n.attachments = n.attachments.map((a) => ({
          ...a,
          mediaRef: null,
          ...(media && 'b64' in media ? { fixtureBytesB64: media.b64 } : { fixtureAvailability: media && 'availability' in media ? media.availability : 'unavailable' }),
        }));
      }
      out.push(n);
    }
  }
  return out;
}

export async function replayFixtureStep(db: Db, ctx: IngestContext, step: string, bundle = loadFixtureBundle()): Promise<IngestStats> {
  const events = bundle.steps[step];
  if (!events) throw new Error(`unknown fixture step ${step}`);
  const total: IngestStats = { inserted: 0, duplicates: 0, edits: 0, revokes: 0, pendingControls: 0, staleIgnored: 0, excludedUnselected: 0, excludedCutoff: 0, excludedHistoryCap: 0, ignored: 0, conflicts: 0 };
  // Apply event-by-event to preserve native ordering (out-of-order cases depend on it).
  for (const e of events) {
    const { stats } = await ingestEvents(db, ctx, normalizeFixtureEvents(bundle, [e]));
    for (const k of Object.keys(total) as (keyof IngestStats)[]) total[k] += stats[k];
  }
  return total;
}
