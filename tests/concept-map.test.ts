import { describe, expect, it } from 'vitest';
import { buildConceptMap, type AskResult } from '../src/ui/AskMap';

const p = (id: string, title: string, depth: number) => ({ id, title, depth });
const root = p('r', 'Knowledge', 0);
const game = p('a', 'Game Development', 1);
const ninja = p('t', 'Ninja-Inspired Game Design', 2);
const art = p('s', 'Pixel Art', 2);

const res: AskResult = {
  query: 'show me information related to Ninja',
  interpretation: 'Messages about the ninja game',
  terms: ['ninja'],
  topics: [{ chat_id: 'c', topic_id: 't', path: [root, game, ninja] }],
  results: [
    ...Array.from({ length: 6 }, (_, i) => ({ message_id: `m${i}`, chat_id: 'c', sender: 'Han', snippet: `ninja ${i}`, review: 'missed', topic_paths: [[root, game, ninja]] })),
    { message_id: 'x', chat_id: 'c', sender: 'Qi', snippet: 'ninja sprites', review: 'read', topic_paths: [[root, game, art], [p('res', 'Resources', 0), p('img', 'Images', 1)]] },
    { message_id: 'y', chat_id: 'c', sender: 'Qi', snippet: 'ninja?', review: 'read', topic_paths: [] },
  ],
};

describe('Ask concept map', () => {
  const opened: string[] = [];
  const { nodes, edges } = buildConceptMap(res, { onOpenTopic: (_c, id) => opened.push(`topic:${id}`), onOpenMessage: (_c, id) => opened.push(`msg:${id}`) });
  const kind = (id: string) => nodes.find((n) => n.id === id)?.data.kind;

  it('types nodes as question, abstraction, picked topic, sibling and detail', () => {
    expect(kind('q')).toBe('query');
    // Knowledge → Game Development has one branch, so it reads as one step.
    expect(kind('r')).toBe('abstraction');
    expect(nodes.find((n) => n.id === 'r')?.data.label).toBe('Knowledge › Game Development');
    expect(kind('a')).toBeUndefined();
    expect(kind('t')).toBe('topic');
    expect(kind('s')).toBe('sibling');
    expect(kind('m:x')).toBe('detail');
    expect(nodes.find((n) => n.id === 'r')?.data.root).toBe('KNOWLEDGE');
  });

  it('links the chain from the question down to details, capping details per topic', () => {
    const has = (a: string, b: string) => edges.some((e) => e.source === a && e.target === b);
    expect(has('q', 'r') && has('r', 't') && has('r', 's') && has('t', 'm:m0') && has('s', 'm:x')).toBe(true);
    // Messages without a topic hang off the question itself.
    expect(has('q', 'm:y')).toBe(true);
    expect(edges.filter((e) => e.source === 't').length).toBe(4);
  });

  it('shows a message once, linking its other topics across branches', () => {
    expect(nodes.filter((n) => n.id === 'm:x')).toHaveLength(1);
    const cross = edges.filter((e) => e.className === 'e-cross');
    expect(cross.map((e) => [e.target, e.label])).toEqual([['m:x', 'also in']]);
    expect(kind(cross[0].source)).toBe('sibling');
  });

  it('lays parents out left of their children without overlapping leaves', () => {
    const pos = (id: string) => nodes.find((n) => n.id === id)!.position;
    expect(pos('q').x).toBeLessThan(pos('r').x);
    expect(pos('t').x).toBeLessThan(pos('m:m0').x);
    const leaves = nodes.filter((n) => n.data.kind === 'detail').map((n) => n.position.y).sort((a, b) => a - b);
    leaves.slice(1).forEach((y, i) => expect(y - leaves[i]).toBeGreaterThanOrEqual(96));
  });

  it('clicking a topic or detail opens it', () => {
    nodes.find((n) => n.id === 't')!.data.onClick!();
    nodes.find((n) => n.id === 'm:x')!.data.onClick!();
    expect(opened).toEqual(['topic:t', 'msg:x']);
  });
});
