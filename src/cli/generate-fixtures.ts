import fs from 'node:fs';
import path from 'node:path';
import { buildEvaluation } from '../fixtures/evaluation';
import { generateFixtures } from '../fixtures/generate';

const out = path.resolve(process.argv[2] ?? 'fixtures/v1');
fs.mkdirSync(out, { recursive: true });
const { manifest, media, steps } = generateFixtures();
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
fs.writeFileSync(path.join(out, 'media.json'), JSON.stringify(media));
fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(steps));
fs.writeFileSync(path.join(out, 'evaluation.json'), JSON.stringify(buildEvaluation(manifest), null, 1));
const deepTopics = manifest.topics.filter((t) => t.chat === 'builders' && t.root === 'KNOWLEDGE');
console.log(
  JSON.stringify(
    {
      out,
      human: manifest.totals.human,
      perChat: manifest.totals.perChat,
      files: manifest.totals.files,
      urls: manifest.totals.urls,
      topics: manifest.topics.length,
      maxKnowledgeDepth: Math.max(...deepTopics.map((t) => t.depth)),
    },
    null,
    1,
  ),
);
