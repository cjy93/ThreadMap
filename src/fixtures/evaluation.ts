// Frozen evaluation split for human review: up to 20 distinct root examples per root (74 total),
// 20 cross-chat candidate pairs, 10 source/file finding tasks. Expectations are
// developer-authored from the synthetic content; semantic scoring is human.
import type { Manifest } from './generate';

const ROOT = { K: 'KNOWLEDGE', G: 'GENERAL_CHAT', E: 'EVENTS_ACTIVITIES', R: 'RESOURCES' } as const;

export function buildEvaluation(m: Manifest) {
  const pathOf = (k: string) => k.slice(k.indexOf(':') + 1);
  const initial = m.messages.filter((x) => x.phase !== 'update');
  const byRoot: Record<string, typeof initial> = { K: [], G: [], E: [], R: [] };
  for (const x of initial) byRoot[pathOf(x.topic)[0]].push(x);
  // Deterministic spread: every n-th message per root.
  // Distinct picks; a root with fewer than n messages contributes all of them.
  const pick = (list: typeof initial, n: number) => [...new Set(Array.from({ length: Math.min(n, list.length) }, (_, i) => list[Math.floor((i * list.length) / Math.min(n, list.length))]))];
  const rootExamples = (['K', 'G', 'E', 'R'] as const).flatMap((r) =>
    pick(byRoot[r], 20).map((x) => ({
      native_id: x.nativeId,
      chat: x.chat,
      expected_primary_root: ROOT[r],
      // Overlapping content may legitimately belong to more than one root.
      admissible_roots: [...new Set([ROOT[r], ...x.also.map((a) => ROOT[pathOf(a)[0] as 'K'])])],
      expected_topic_path: pathOf(x.topic),
    })),
  );

  const topics = (chat: string) => m.topics.filter((t) => t.chat === chat && t.depth > 0).map((t) => t.path);
  const B = topics('builders');
  const M = topics('music');
  const pairs: { a: string; b: string; expected_related: boolean; reason: string }[] = [
    { a: 'builders:K/Programming/Hackathons/Solutions/Authentication/Tokens', b: 'study:K/Programming/Authentication/Tokens', expected_related: true, reason: 'both discuss refresh-token rotation; shared oauth.net link' },
    { a: 'builders:K/Programming/Hackathons/Solutions/Authentication/Tokens/Refresh flow', b: 'study:K/Programming/Authentication/Tokens', expected_related: true, reason: 'shared resource https://oauth.net/2/refresh-tokens/' },
    { a: 'builders:K/Programming/Python', b: 'study:K/Programming/Python', expected_related: true, reason: 'both about Python tooling/practice' },
    { a: 'builders:K/History', b: 'study:K/History', expected_related: true, reason: 'history of computing / hackathons' },
    { a: 'builders:K/Programming/School work/Tips/Algorithms', b: 'study:K/Programming/Algorithms', expected_related: true, reason: 'algorithm revision and DP' },
    { a: 'builders:G/Casual chat', b: 'study:G/Casual chat', expected_related: false, reason: 'social chatter only' },
    { a: 'builders:K/Programming/Hackathons/Tips', b: 'music:K/Music/Practice', expected_related: false, reason: 'word overlap (practice) without shared subject' },
    { a: 'study:K/Programming/Python/Generators', b: 'music:K/Music/Theory', expected_related: false, reason: 'unrelated subjects' },
    { a: 'builders:R/Web links', b: 'study:R/Web links', expected_related: false, reason: 'generic link lists with different subjects' },
    { a: 'builders:K/Programming/Hackathons/Solutions/Deployment', b: 'study:K/Programming/Authentication/Sessions', expected_related: false, reason: 'different subjects' },
  ];
  // Pad to 20 with deterministic unrelated cross-chat pairs.
  for (let i = 0; pairs.length < 20; i++) {
    const a = B[(i * 5) % B.length];
    const b = M[(i * 3) % M.length];
    if (!pairs.some((p) => p.a === `builders:${a}` && p.b === `music:${b}`)) pairs.push({ a: `builders:${a}`, b: `music:${b}`, expected_related: false, reason: 'unrelated chats/subjects' });
  }

  const ref = (r: string) => m.refs[r];
  const finding = [
    { id: 'F1', task: 'With Show depth = 0, from Knowledge, open the refresh-flow sequence diagram file.', expect: { native_id: ref('refresh-file'), file: 'refresh-flow-diagram.pdf' }, depth_shown: 0, deep: true },
    { id: 'F2', task: 'With Show depth = 1, from Programming, find who suggested binding the refresh token to the device.', expect: { native_id: ref('refresh-4') }, depth_shown: 1, deep: true },
    { id: 'F3', task: 'Expand Knowledge → Programming → Hackathons → Solutions → Authentication → Tokens → Refresh flow and open the OAuth spec link message.', expect: { native_id: ref('refresh-url') }, depth_shown: 'all', deep: true },
    { id: 'F4', task: 'Find the judging rubric PDF shared in Builders and Hackathons.', expect: { file: 'judging-rubric.pdf' }, depth_shown: 2, deep: false },
    { id: 'F5', task: 'Find the Fluent Python sample chapter in the study group.', expect: { file: 'fluent-python-sample.pdf' }, depth_shown: 2, deep: false },
    { id: 'F6', task: 'Find the Chinese explanation of generators.', expect: { text_contains: '生成器' }, depth_shown: 2, deep: false },
    { id: 'F7', task: 'Follow the related link from the study group Tokens topic into Builders and open evidence on both sides.', expect: { related: true }, depth_shown: 2, deep: false },
    { id: 'F8', task: 'Find the venue logistics discussion and its (unavailable) map image.', expect: { file: 'venue-map.png', availability: 'unavailable' }, depth_shown: 2, deep: false },
    { id: 'F9', task: 'Using Date + Topic + Missed, list missed messages about Tokens from 2–3 Sep 2026 (SGT).', expect: { filter: { from: '2026-09-02', to: '2026-09-03', topic: 'Tokens', status: 'missed' } }, depth_shown: 1, deep: true },
    { id: 'F10', task: 'Find the hand sketch image Mei commented on.', expect: { file: 'hand-sketch.png' }, depth_shown: 2, deep: false },
  ];
  return { version: m.version, root_examples: rootExamples, cross_chat_pairs: pairs, finding_tasks: finding };
}
