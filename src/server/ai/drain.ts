// In-process job runner used by tests, demo seeding and evidence scripts. The
// hosted worker uses pg-boss for the same runJob/dispatchOutbox functions.
import { and, eq, inArray } from 'drizzle-orm';
import * as s from '../../db/schema';
import { dispatchOutbox, maybeScheduleInitialTaxonomy, runJob, type PipelineDeps } from './pipeline';

export async function drainJobs(deps: PipelineDeps, opts: { chatIds?: string[]; maxJobs?: number; swallowErrors?: boolean } = {}) {
  const ran: { id: string; status: string }[] = [];
  const max = opts.maxJobs ?? 500;
  for (let round = 0; round < max; round++) {
    await dispatchOutbox(deps.db, deps.cfg, { force: true });
    const pending = await deps.db
      .select({ id: s.analysisJobs.id, chatId: s.analysisJobs.chatId })
      .from(s.analysisJobs)
      .where(and(eq(s.analysisJobs.status, 'pending'), opts.chatIds ? inArray(s.analysisJobs.chatId, opts.chatIds) : undefined))
      .orderBy(s.analysisJobs.createdAt)
      .limit(1);
    if (!pending.length) {
      // Debounced initial taxonomy once extraction has settled.
      const chats = opts.chatIds ?? (await deps.db.select({ id: s.chats.id }).from(s.chats).where(eq(s.chats.selected, true))).map((c) => c.id);
      let scheduled = false;
      for (const c of chats) if (await maybeScheduleInitialTaxonomy(deps.db, c)) scheduled = true;
      if (!scheduled) break;
      continue;
    }
    try {
      const out = await runJob(deps, pending[0].id);
      ran.push({ id: pending[0].id, status: out.status });
    } catch (e) {
      ran.push({ id: pending[0].id, status: 'failed' });
      if (!opts.swallowErrors) throw e;
    }
    if (ran.length >= max) break;
  }
  return ran;
}
