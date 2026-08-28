import { z } from "zod";

import { REASONING_EFFORTS } from "../core/types.js";
import {
  ROUTING_LANES,
  TASK_AUTHORITIES,
  TASK_KINDS,
  TASK_RISKS,
} from "../sdd/routing/index.js";

const safeIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
const safeVersion = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);
const repositoryPath = z.string().min(1).max(4_096);
const checkIds = z.array(safeIdentifier).max(64);

const codexExecutionPolicySchema = z
  .object({
    model: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
      .nullable(),
    reasoningEffort: z.enum(REASONING_EFFORTS).nullable(),
  })
  .strict();

function optionalMapSchema<
  const T extends readonly string[],
  S extends z.ZodType,
>(keys: T, value: S): z.ZodObject<Record<T[number], z.ZodOptional<S>>> {
  return z
    .object(
      Object.fromEntries(keys.map((key) => [key, value.optional()])) as Record<
        T[number],
        z.ZodOptional<S>
      >,
    )
    .strict();
}

export const projectProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: safeIdentifier,
    profileVersion: safeVersion,
    laneCapabilities: z
      .object({
        codex: z
          .array(
            z
              .object({
                id: safeIdentifier,
                score: z.number().int().min(0).max(4),
              })
              .strict(),
          )
          .max(64),
        "claude-host": z
          .array(
            z
              .object({
                id: safeIdentifier,
                score: z.number().int().min(0).max(4),
              })
              .strict(),
          )
          .max(64),
      })
      .strict(),
    taskPolicies: z
      .array(
        z
          .object({
            kind: z.enum(TASK_KINDS),
            requirements: z
              .array(
                z
                  .object({
                    capabilityId: safeIdentifier,
                    minimumScore: z.number().int().min(1).max(4),
                    weight: z.number().int().min(1).max(100),
                  })
                  .strict(),
              )
              .min(1)
              .max(64),
          })
          .strict(),
      )
      .min(1)
      .max(TASK_KINDS.length),
    checkProfiles: z
      .array(
        z
          .object({
            id: safeIdentifier,
            cwd: repositoryPath,
            argv: z.array(z.string().min(1).max(4_096)).min(1).max(32),
          })
          .strict(),
      )
      .max(64),
    requiredChecks: z
      .object({
        always: checkIds.optional(),
        byKind: optionalMapSchema(TASK_KINDS, checkIds).optional(),
        byRisk: optionalMapSchema(TASK_RISKS, checkIds).optional(),
        byAuthority: optionalMapSchema(TASK_AUTHORITIES, checkIds).optional(),
      })
      .strict()
      .optional(),
    codexPolicy: z
      .object({
        default: codexExecutionPolicySchema,
        byKind: optionalMapSchema(
          TASK_KINDS,
          codexExecutionPolicySchema,
        ).optional(),
        byRisk: optionalMapSchema(
          TASK_RISKS,
          codexExecutionPolicySchema,
        ).optional(),
      })
      .strict(),
    writePolicy: z
      .object({
        allowedRoots: z.array(repositoryPath).max(64),
        additionalDeniedRoots: z.array(repositoryPath).max(64).optional(),
      })
      .strict(),
  })
  .strict();

export const profiledRoutingTaskSchema = z
  .object({
    id: safeIdentifier,
    effortPoints: z.number().int().min(1).max(100),
    risk: z.enum(TASK_RISKS),
    authority: z.enum(TASK_AUTHORITIES),
    kind: z.enum(TASK_KINDS),
    dependencies: z.array(safeIdentifier).max(64).optional(),
    writeScopes: z.array(repositoryPath).max(64).optional(),
    eligibleLanes: z.array(z.enum(ROUTING_LANES)).min(1).max(2).optional(),
    preferredLane: z.enum(ROUTING_LANES).optional(),
  })
  .strict();
