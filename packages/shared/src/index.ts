// Shared wire types between desktop and server. Runtime-validated with zod at the server boundary.
import { z } from 'zod';

export const Channel = z.enum(['me', 'them', 'mixed']);
export type Channel = z.infer<typeof Channel>;

export const Platform = z.enum(['teams', 'meet', 'zoom', 'other']);
export type Platform = z.infer<typeof Platform>;

export const MeetingStatus = z.enum(['live', 'uploading', 'transcribing', 'summarizing', 'done', 'error']);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

const id = z.string().min(1).max(100);

export const MeetingCreate = z.object({
  id: z.uuid().optional(),
  title: z.string().default('Untitled meeting').transform((s) => s.slice(0, 300)),
  platform: Platform.nullable().optional(),
  channels: z.union([z.literal(1), z.literal(2)]).default(2),
  started_at: z.iso.datetime({ offset: true }),
  language: z.string().max(10).optional(),
  final_transcript: z.boolean().default(true),
});
export type MeetingCreate = z.infer<typeof MeetingCreate>;

export const Segment = z.object({
  id,
  channel: Channel,
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  text: z.string().max(20000),
});
export type Segment = z.infer<typeof Segment>;
export const SegmentBatch = z.object({ segments: z.array(Segment).max(1000) });

export const Hint = z.object({
  question: z.string().nullable(),
  answer_hint: z.string(),
  follow_up_questions: z.array(z.string()),
  missing_topics: z.array(z.string()),
  // checklist of the user's prep file (empty without one); older hints lack it
  prep_points: z.array(z.object({ point: z.string(), covered: z.boolean() })).default([]),
});
export type Hint = z.infer<typeof Hint>;
export const HintIn = z.object({ id, at_ms: z.number().int().nonnegative(), payload: Hint });

export const MarkIn = z.object({ id, at_ms: z.number().int().nonnegative(), label: z.string().max(300).nullable().optional() });

export const Finish = z.object({
  ended_at: z.iso.datetime({ offset: true }),
  duration_s: z.number().int().nonnegative().optional(),
  force: z.boolean().optional(),
});

export type ActionItem = { id: number; text: string; owner: string | null; due_date: string | null; done: boolean };

/** GET /api/meetings/:id */
export type MeetingView = {
  id: string;
  title: string;
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  platform: Platform | null;
  channels: number;
  status: MeetingStatus;
  progress: number;
  audio_bytes: number;
  error: string | null;
  speakers: number;
  summary: { markdown: string; key_points: string[]; decisions: string[] } | null;
  action_items: ActionItem[];
};

/** JSON schema used for OpenRouter structured output of live hints. */
export const HINT_JSON_SCHEMA = {
  name: 'hint',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['question', 'answer_hint', 'follow_up_questions', 'missing_topics', 'prep_points'],
    properties: {
      question: { type: ['string', 'null'], description: 'The latest open question asked by the other side, verbatim-ish, or null.' },
      answer_hint: { type: 'string', description: 'A short suggested answer for the user (1-2 sentences).' },
      follow_up_questions: { type: 'array', items: { type: 'string' }, description: 'Up to 3 useful questions the user could ask next.' },
      missing_topics: { type: 'array', items: { type: 'string' }, description: 'Up to 3 relevant topics not yet covered.' },
      prep_points: {
        type: 'array',
        description: "The points the user planned in their prep notes, each marked covered once it came up in the call. Empty without prep notes.",
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['point', 'covered'],
          properties: { point: { type: 'string' }, covered: { type: 'boolean' } },
        },
      },
    },
  },
} as const;
