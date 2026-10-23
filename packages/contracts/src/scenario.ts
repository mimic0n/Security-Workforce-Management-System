import { z } from "zod";

export const ScenarioSeedSchema = z.object({
  date: z.string(),
  present: z.number().int().default(45),
  fixtureSet: z.string().default("full-roster"),
  policyOverrides: z.record(z.any()).default({})
});
export type ScenarioSeed = z.infer<typeof ScenarioSeedSchema>;

export const ScenarioTimelineActionSchema = z.object({
  at: z.string(),
  do: z.string(),
  with: z.record(z.any()).optional().default({})
});
export type ScenarioTimelineAction = z.infer<typeof ScenarioTimelineActionSchema>;

export const ScenarioExpectationSchema = z.object({
  within: z.string().optional(),
  after: z.number().optional(),
  assert: z.string(),
  post: z.string().optional(),
  guard: z.string().optional(),
  recipient: z.string().optional(),
  event: z.string().optional(),
  kind: z.string().optional(),
  equals: z.any().optional(),
  lte: z.number().optional(),
  gte: z.number().optional(),
  exists: z.boolean().optional(),
  notEquals: z.any().optional(),
  passes_legal_guard: z.boolean().optional(),
  description: z.string().optional()
});
export type ScenarioExpectation = z.infer<typeof ScenarioExpectationSchema>;

export const ScenarioDefinitionSchema = z.object({
  id: z.string(),
  title: z.string(),
  seed: ScenarioSeedSchema,
  timeline: z.array(ScenarioTimelineActionSchema),
  expect: z.array(ScenarioExpectationSchema)
});
export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;

export const AssertionResultSchema = z.object({
  assert: z.string(),
  passed: z.boolean(),
  expected: z.any().optional(),
  actual: z.any().optional(),
  message: z.string().optional(),
  description: z.string().optional()
});
export type AssertionResult = z.infer<typeof AssertionResultSchema>;

export const SimRunResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  passed: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  assertions: z.array(AssertionResultSchema),
  error: z.string().optional()
});
export type SimRunResult = z.infer<typeof SimRunResultSchema>;

export const SimClockJumpSchema = z.object({
  to: z.string()
});
export type SimClockJumpDto = z.infer<typeof SimClockJumpSchema>;

export const SimClockSpeedSchema = z.object({
  speed: z.number().min(0)
});
export type SimClockSpeedDto = z.infer<typeof SimClockSpeedSchema>;

export const SimResetSchema = z.object({
  fixtureSet: z.string().optional(),
  date: z.string().optional()
});
export type SimResetDto = z.infer<typeof SimResetSchema>;
