// Output contracts validated in application code regardless of provider mode.
import { z } from 'zod';

export const PROMPT_VERSION = 'tm-prompts-v1';
export const SCHEMA_VERSION = 'tm-schemas-v1';
export const PIPELINE_VERSION = 'tm-pipeline-v2';

const RootEnum = z.enum(['KNOWLEDGE', 'GENERAL_CHAT', 'EVENTS_ACTIVITIES', 'RESOURCES']);
const ref = z.string().min(1).max(16);

export const ExtractionSchema = z.object({
  units: z
    .array(
      z.object({
        unit_key: z.string().min(1).max(40),
        primary_root: RootEnum,
        discussion_title: z.string().min(1).max(120),
        topic_terms: z.array(z.string().min(1).max(60)).max(8),
        message_refs: z.array(ref).min(1).max(80),
        summary_bullets: z
          .array(z.object({ text: z.string().min(1).max(400), evidence_refs: z.array(ref).min(1).max(8) }))
          .max(5),
        resource_refs: z.array(ref).max(40).default([]),
        // Messages that add nothing on their own; they stay in the unit but not on the map.
        filler_refs: z.array(ref).max(80).default([]),
        needs_review: z.boolean().default(false),
      }),
    )
    .max(40),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/** Flat node list with parent references; never a fixed-level object. */
export const TaxonomySchema = z.object({
  nodes: z
    .array(
      z.object({
        key: z.string().min(1).max(120),
        parent: z.string().min(1).max(120),
        title: z.string().min(1).max(80),
        aliases: z.array(z.string().max(60)).max(6).default([]),
        may_subdivide: z.boolean().default(false),
      }),
    )
    .max(60),
  assignments: z.array(z.object({ unit_key: z.string(), topic: z.string() })).max(200),
  secondary_placements: z.array(z.object({ message_ref: ref, topic: z.string() })).max(200).default([]),
  no_useful_subdivision: z.boolean().default(false),
});
export type Taxonomy = z.infer<typeof TaxonomySchema>;

export const AssignmentSchema = z.object({
  assignments: z
    .array(
      z.object({
        unit_key: z.string(),
        topic_id: z.string().nullable(),
        new_topic: z.object({ parent_id: z.string(), title: z.string().min(1).max(80) }).nullable().default(null),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(80),
  secondary_placements: z.array(z.object({ message_ref: ref, topic_id: z.string() })).max(200).default([]),
});
export type Assignment = z.infer<typeof AssignmentSchema>;

export const LinkVerdictSchema = z.object({
  related: z.boolean(),
  relation_type: z.enum(['RELATED_TOPIC', 'SHARED_RESOURCE']).nullable(),
  reason: z.string().max(300),
  a_evidence_refs: z.array(ref).max(6),
  b_evidence_refs: z.array(ref).max(6),
});
export type LinkVerdict = z.infer<typeof LinkVerdictSchema>;

export const CapabilitySchema = z.object({ ok: z.literal(true), role: z.string(), echo: z.string() });

/** What the vision model sees in an image or video frame. */
export const DescribeSchema = z.object({ description: z.string().min(1).max(600) });

/** Ask: a plain-language question turned into what to look for. */
export const AskSchema = z.object({
  interpretation: z.string().max(240),
  terms: z.array(z.string().min(1).max(48)).max(16),
  topic_keys: z.array(z.string()).max(10).default([]),
});

/** Ask, second look: other names the chat uses for the same thing. */
export const AliasSchema = z.object({ aliases: z.array(z.string().min(1).max(48)).max(8).default([]), parts: z.array(z.string().min(1).max(48)).max(8).default([]) });

/** Root re-check: discussions to move to another root. */
export const RootReviewSchema = z.object({ roots: z.array(z.object({ key: z.string().min(1).max(16), root: RootEnum })).max(200).default([]) });

/** Answers given without WhatsApp's Reply: each links a message to the earlier one it answers. */
export const TrailSchema = z.object({ continues: z.array(ref).max(200).default([]), resolved_by: ref.nullable().default(null) });
export const AnswersSchema = z.object({ links: z.array(z.object({ ref: ref, answers: ref })).max(200).default([]) });

/** Answer: a direct reply to an Ask question, each point citing the messages or discussions it comes from. */
export const AnswerSchema = z.object({
  answer: z.string().max(1500),
  points: z.array(z.object({ text: z.string().max(400), refs: z.array(z.string()).max(6).default([]) })).max(16).default([]),
  enough: z.boolean().default(true),
});

/** Regroup: broader parents for sibling topics that belong together. */
export const RegroupSchema = z.object({
  groups: z.array(z.object({ title: z.string().min(1).max(80), children: z.array(z.string()).min(2).max(40) })).max(12).default([]),
});

/** Split: one topic whose title joins several subjects becomes one topic per subject. */
export const SplitSchema = z.object({
  parts: z
    .array(z.object({ title: z.string().min(1).max(80), unit_subtopic: z.string().max(80).nullish(), children: z.array(z.string()).default([]), units: z.array(z.string()).default([]) }))
    .max(6)
    .default([]),
});

/** Filler screening: refs of messages that add nothing on their own. */
export const FillerSchema = z.object({ filler: z.array(ref).max(400).default([]) });

/** Concept map, step 1: the subject, the questions asked and how they were answered, and what to look up on the web. */
export const StudyPlanSchema = z.object({
  subject: z.string().min(1).max(160),
  questions: z
    .array(z.object({ question: z.string().min(1).max(300), asked_in: z.array(z.string()).max(4).default([]), answered_in: z.array(z.string()).max(8).default([]) }))
    .max(12)
    .default([]),
  searches: z.array(z.object({ query: z.string().min(1).max(200), why: z.string().max(200).default('') })).max(6).default([]),
});

/** Concept map, step 2: linked concepts, a study guide and what is still open. Refs are m… (messages) or w… (web pages). */
export const StudyMapSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().max(1200).default(''),
  concepts: z
    .array(z.object({ key: z.string().min(1).max(16), label: z.string().min(1).max(90), kind: z.string().max(20).default('concept'), explanation: z.string().max(1200).default(''), refs: z.array(z.string()).max(10).default([]) }))
    .min(1)
    .max(30),
  relations: z.array(z.object({ from: z.string().min(1).max(16), to: z.string().min(1).max(16), label: z.string().max(60).default('') })).max(60).default([]),
  guide: z.array(z.object({ heading: z.string().min(1).max(120), text: z.string().max(2000), refs: z.array(z.string()).max(10).default([]) })).max(10).default([]),
  gaps: z.array(z.string().max(300)).max(8).default([]),
});

/** JSON Schemas (subset) for providers that support schema-constrained output. */
export const JSON_SCHEMAS: Record<string, Record<string, unknown>> = {
  extraction: z.toJSONSchema(ExtractionSchema) as Record<string, unknown>,
  taxonomy: z.toJSONSchema(TaxonomySchema) as Record<string, unknown>,
  assignment: z.toJSONSchema(AssignmentSchema) as Record<string, unknown>,
  link: z.toJSONSchema(LinkVerdictSchema) as Record<string, unknown>,
  capability: z.toJSONSchema(CapabilitySchema) as Record<string, unknown>,
  describe: z.toJSONSchema(DescribeSchema) as Record<string, unknown>,
  ask: z.toJSONSchema(AskSchema) as Record<string, unknown>,
  answer: z.toJSONSchema(AnswerSchema) as Record<string, unknown>,
  regroup: z.toJSONSchema(RegroupSchema) as Record<string, unknown>,
  split: z.toJSONSchema(SplitSchema) as Record<string, unknown>,
  filler: z.toJSONSchema(FillerSchema) as Record<string, unknown>,
  alias: z.toJSONSchema(AliasSchema) as Record<string, unknown>,
  answers: z.toJSONSchema(AnswersSchema) as Record<string, unknown>,
  trail: z.toJSONSchema(TrailSchema) as Record<string, unknown>,
  roots: z.toJSONSchema(RootReviewSchema) as Record<string, unknown>,
  study_plan: z.toJSONSchema(StudyPlanSchema) as Record<string, unknown>,
  study_map: z.toJSONSchema(StudyMapSchema) as Record<string, unknown>,
};
