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
};
