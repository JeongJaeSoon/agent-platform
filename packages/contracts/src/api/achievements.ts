import { z } from "zod";

import {
  agentIdSchema,
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";

/**
 * What the platform itself sees a session do. Fixed in code: adding one
 * takes code and a migration (docs/contributing/decisions/achievement-rules.md §3).
 */
export const ACHIEVEMENT_EVIDENCE_KIND_VALUES = [
  "github_pull_request",
  "github_review",
  "out_file",
  "conversation",
] as const;

/** `always` counts without asking the judge; `luna` asks it. */
export const ACHIEVEMENT_RULE_JUDGE_VALUES = ["always", "luna"] as const;

/** Non-archived types per workspace. */
export const ACHIEVEMENT_TYPE_LIMIT = 50;
/** Rules in use (latest version, not disabled) per workspace. */
export const ACHIEVEMENT_RULE_LIMIT = 30;

export const ACHIEVEMENT_CATEGORY_NAME_MAX = 32;
export const ACHIEVEMENT_TYPE_NAME_MAX = 40;
export const ACHIEVEMENT_RULE_TITLE_MAX = 80;
export const ACHIEVEMENT_RULE_DEFINITION_MAX = 2_000;
export const ACHIEVEMENT_TYPE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

export const achievementEvidenceKindSchema = z.enum(
  ACHIEVEMENT_EVIDENCE_KIND_VALUES,
);
export const achievementRuleJudgeSchema = z.enum(ACHIEVEMENT_RULE_JUDGE_VALUES);

/** Every workspace has these, from its creation or from the migration. */
export const BUILTIN_ACHIEVEMENT_TYPES = [
  {
    key: "pull_request",
    name: "GitHub PR",
    evidence_kind: "github_pull_request",
  },
  { key: "code_review", name: "코드 리뷰", evidence_kind: "github_review" },
  { key: "document", name: "문서", evidence_kind: "out_file" },
] as const satisfies readonly {
  key: string;
  name: string;
  evidence_kind: (typeof ACHIEVEMENT_EVIDENCE_KIND_VALUES)[number];
}[];

// A stored position is any integer column value; one set by hand stays well
// under it, so a new category can always go after the last.
const positionSchema = z.number().int().min(0).max(2_147_483_647);
const positionRequestSchema = z.number().int().min(0).max(1_000_000);
export const achievementCategoryNameSchema = z
  .string()
  .min(1)
  .max(ACHIEVEMENT_CATEGORY_NAME_MAX);
export const achievementTypeKeySchema = z
  .string()
  .regex(ACHIEVEMENT_TYPE_KEY_PATTERN);
export const achievementTypeNameSchema = z
  .string()
  .min(1)
  .max(ACHIEVEMENT_TYPE_NAME_MAX);
export const achievementRuleTitleSchema = z
  .string()
  .min(1)
  .max(ACHIEVEMENT_RULE_TITLE_MAX);
export const achievementRuleDefinitionSchema = z
  .string()
  .min(1)
  .max(ACHIEVEMENT_RULE_DEFINITION_MAX);

export const achievementCategorySchema = z
  .object({
    id: z.uuid(),
    name: achievementCategoryNameSchema,
    position: positionSchema,
    created_by: userIdSchema,
    created_at: timestampSchema,
    archived_at: timestampSchema.nullable(),
    archived_by: userIdSchema.nullable(),
  })
  .strict();

export const achievementTypeSchema = z
  .object({
    id: z.uuid(),
    key: achievementTypeKeySchema,
    name: achievementTypeNameSchema,
    evidence_kind: achievementEvidenceKindSchema,
    builtin: z.boolean(),
    /** Null for a built-in type. */
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    archived_at: timestampSchema.nullable(),
    archived_by: userIdSchema.nullable(),
  })
  .strict();

export const achievementRuleSchema = z
  .object({
    id: z.uuid(),
    family_id: z.uuid(),
    version: z.number().int().positive(),
    category_id: z.uuid(),
    title: achievementRuleTitleSchema,
    type_id: z.uuid(),
    definition: achievementRuleDefinitionSchema,
    judge: achievementRuleJudgeSchema,
    /** Null: every agent. */
    agent_ids: z.array(agentIdSchema).nullable(),
    created_by: userIdSchema,
    created_at: timestampSchema,
    superseded_by: z.uuid().nullable(),
    disabled_at: timestampSchema.nullable(),
    disabled_by: userIdSchema.nullable(),
  })
  .strict();

export const listAchievementCategoriesResponseSchema = z
  .object({ items: z.array(achievementCategorySchema) })
  .strict();
export const listAchievementTypesResponseSchema = z
  .object({ items: z.array(achievementTypeSchema) })
  .strict();
export const listAchievementRulesResponseSchema = z
  .object({ items: z.array(achievementRuleSchema) })
  .strict();

export const createAchievementCategoryRequestSchema = z
  .object({ name: achievementCategoryNameSchema })
  .strict();
export const updateAchievementCategoryRequestSchema = z
  .object({
    name: achievementCategoryNameSchema.optional(),
    position: positionRequestSchema.optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.position !== undefined, {
    message: "name or position is required",
  });

export const createAchievementTypeRequestSchema = z
  .object({
    key: achievementTypeKeySchema,
    name: achievementTypeNameSchema,
    evidence_kind: achievementEvidenceKindSchema,
  })
  .strict();
/** Only the name changes; `key` and `evidence_kind` are fixed. */
export const updateAchievementTypeRequestSchema = z
  .object({ name: achievementTypeNameSchema })
  .strict();

/** The whole rule: a new version replaces every field. */
export const achievementRuleRequestSchema = z
  .object({
    category_id: z.uuid(),
    title: achievementRuleTitleSchema,
    type_id: z.uuid(),
    definition: achievementRuleDefinitionSchema,
    judge: achievementRuleJudgeSchema,
    agent_ids: z.null().default(null),
  })
  .strict();

export const achievementCategoryParamsSchema = z
  .object({ id: z.uuid() })
  .strict();
export const achievementTypeParamsSchema = achievementCategoryParamsSchema;
export const achievementRuleFamilyParamsSchema = z
  .object({ family_id: z.uuid() })
  .strict();

/** `receipt_id` is null when nothing changed (archiving the archived). */
export const achievementCategoryChangeResponseSchema = z
  .object({
    category: achievementCategorySchema,
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();
export const achievementTypeChangeResponseSchema = z
  .object({
    type: achievementTypeSchema,
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();
export const achievementRuleChangeResponseSchema = z
  .object({
    rule: achievementRuleSchema,
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

export type AchievementEvidenceKind = z.infer<
  typeof achievementEvidenceKindSchema
>;
export type AchievementRuleJudge = z.infer<typeof achievementRuleJudgeSchema>;
export type AchievementCategory = z.infer<typeof achievementCategorySchema>;
export type AchievementType = z.infer<typeof achievementTypeSchema>;
export type AchievementRule = z.infer<typeof achievementRuleSchema>;
export type ListAchievementCategoriesResponse = z.infer<
  typeof listAchievementCategoriesResponseSchema
>;
export type ListAchievementTypesResponse = z.infer<
  typeof listAchievementTypesResponseSchema
>;
export type ListAchievementRulesResponse = z.infer<
  typeof listAchievementRulesResponseSchema
>;
export type CreateAchievementCategoryRequest = z.infer<
  typeof createAchievementCategoryRequestSchema
>;
export type UpdateAchievementCategoryRequest = z.infer<
  typeof updateAchievementCategoryRequestSchema
>;
export type CreateAchievementTypeRequest = z.infer<
  typeof createAchievementTypeRequestSchema
>;
export type UpdateAchievementTypeRequest = z.infer<
  typeof updateAchievementTypeRequestSchema
>;
export type AchievementRuleRequest = z.infer<
  typeof achievementRuleRequestSchema
>;
export type AchievementCategoryChangeResponse = z.infer<
  typeof achievementCategoryChangeResponseSchema
>;
export type AchievementTypeChangeResponse = z.infer<
  typeof achievementTypeChangeResponseSchema
>;
export type AchievementRuleChangeResponse = z.infer<
  typeof achievementRuleChangeResponseSchema
>;
