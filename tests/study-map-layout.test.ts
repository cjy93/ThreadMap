import { describe, expect, it } from 'vitest';
import { layoutStudyMap, reverseLabel } from '../src/ui/StudyMap';
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
