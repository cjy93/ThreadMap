import { describe, expect, it } from 'vitest';
import { branchOf, layoutStudyMap, reverseLabel } from '../src/ui/StudyMap';
import type { StudyMap } from '../src/ui/types';

const concept = (key: string, kind: StudyMap['concepts'][number]['kind']) => ({ key, label: key, kind, explanation: '', messages: [], web: [] });

describe('concept map links', () => {
  it('reads every tree link in the direction it is drawn', () => {
    const map = {
      concepts: [concept('core', 'core'), concept('rate', 'detail'), concept('q', 'question')],
      relations: [
        { from: 'rate', to: 'core', label: 'part of' },
        { from: 'q', to: 'rate', label: 'answered by' },
      ],
    } as unknown as StudyMap;
    const { edges } = layoutStudyMap(map);
    const label = (s: string, t: string) => edges.find((e) => e.source === s && e.target === t)?.label;
    // Drawn core → rate and rate → question, against both relations' direction.
    expect(label('core', 'rate')).toBe('has part');
    expect(label('rate', 'q')).toBe('answer to');
  });

  it('keeps a label drawn its own way and marks an unknown reversed one', () => {
    expect(reverseLabel('Answered by')).toBe('answer to');
    expect(reverseLabel('competes with')).toBe('← competes with');
    expect(reverseLabel('')).toBe('');
    const map = { concepts: [concept('core', 'core'), concept('a', 'concept')], relations: [{ from: 'core', to: 'a', label: 'uses' }] } as unknown as StudyMap;
    expect(layoutStudyMap(map).edges[0].label).toBe('uses');
  });
});

describe('concept map focus', () => {
  // Tree: core → a → a1, core → b → x. The link a1 → x is drawn across.
  const map = {
    title: 't',
    summary: '',
    subject: '',
    topic_path: '',
    concepts: (['core', 'a', 'a1', 'b', 'x'] as const).map((key) => ({ key, label: key, kind: key === 'core' ? ('core' as const) : ('concept' as const), explanation: '', messages: [], web: [] })),
    relations: [
      { from: 'core', to: 'a', label: 'has part' },
      { from: 'a', to: 'a1', label: 'detail' },
      { from: 'core', to: 'b', label: 'has part' },
      { from: 'a1', to: 'x', label: 'example' },
      { from: 'b', to: 'x', label: 'uses' },
    ],
    guide: [],
    gaps: [],
    web: { enabled: false, queries: [], results: [], note: null },
    read: { messages: 0, discussions: 0 },
  };

  it('lights the path to the core, the branch below and direct links; dims the rest', () => {
    const layout = layoutStudyMap(map);
    // a: its path to the core and its branch; not b's side.
    const a = branchOf(map, layout, 'a');
    expect([...a.nodes].sort()).toEqual(['a', 'a1', 'core']);
    expect([...a.edges].sort()).toEqual(['t:a->a1', 't:core->a']);
    // a1: its parent chain, plus x through its direct (cross) link, which is lit too.
    const a1 = branchOf(map, layout, 'a1');
    expect([...a1.nodes].sort()).toEqual(['a', 'a1', 'core', 'x']);
    expect([...a1.edges].some((id) => id.startsWith('x:'))).toBe(true);
    // b: x is in its branch; the cross link a1 → x does not touch b and stays dim.
    const b = branchOf(map, layout, 'b');
    expect([...b.nodes].sort()).toEqual(['b', 'core', 'x']);
    expect([...b.edges].sort()).toEqual(['t:b->x', 't:core->b']);
  });
});
