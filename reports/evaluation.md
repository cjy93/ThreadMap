# ThreadMap evaluation

Status: **UNREVIEWED**. No human review has been performed; no scores are reported. An LLM judging itself would not count as independent review.

Frozen split: `fixtures/v1/evaluation.json` (generated deterministically from `src/fixtures/spec.ts`).

| Target (Section 13) | Set | Status | Numerator / denominator |
| --- | --- | --- | --- |
| ≥85% acceptable primary-root assignments | 74 root examples (20 Knowledge, 20 General Chat, 20 Events and Activities, 14 Resources — every distinct Resources message; admissible label sets for overlapping content) | UNREVIEWED | — |
| ≥80% useful-link precision over ≥10 displayed links | 20 cross-chat candidate pairs (5 expected related, 15 expected unrelated) | UNREVIEWED | — |
| ≥90% fully supported bullets among 30 sampled claims | sampled from live-model summary claims (requires A18) | UNREVIEWED / BLOCKED_EXTERNAL | — |
| ≥8/10 source/file finding tasks | 10 tasks (F1, F2, F9 retrieve deep content while showing depth 0/1; F3 deliberately expands deeper) | UNREVIEWED | — |

Deterministic structural checks (not semantic review): with the FixtureModelProvider, every manifest topic count matches exactly and all 74 root examples land in their expected roots by construction — this validates plumbing only, not model quality.

To run the review: after A18, export the live-analyzed workspace's placements, links and claims for these IDs and have a human reviewer record accept/reject per item, with disagreements and failures, in this file.
