import { z } from "zod";

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const concurrency = z.number().int().min(1).max(16).default(4);

export const ConfigSchema = z.object({
  $schema: z.string().optional(),
  sourceLocale: z.string().min(1),
  targetLocales: z.array(z.string().min(1)).min(1),
  stores: z
    .object({
      play: z.object({ packageName: z.string().min(1) }).optional(),
      appstore: z.object({ appId: z.string().min(1) }).optional(),
    })
    .refine((s) => s.play !== undefined || s.appstore !== undefined, {
      message: "configure at least one store (play or appstore)",
    }),
  translator: z.discriminatedUnion("provider", [
    z.object({
      provider: z.literal("anthropic"),
      model: z.string().min(1).default("claude-opus-5-5"),
      effort: effort.default("medium"),
      concurrency,
    }),
    z.object({
      provider: z.literal("openai-compatible"),
      baseUrl: z.string().url(),
      model: z.string().min(1),
      concurrency,
    }),
  ]),
  context: z.string().default(""),
  glossary: z
    .object({
      doNotTranslate: z.array(z.string()).default([]),
      terms: z.record(z.string(), z.record(z.string(), z.string())).default({}),
    })
    .default({ doNotTranslate: [], terms: {} }),
  paths: z
    .object({
      play: z.string().optional(),
      appstore: z.string().optional(),
    })
    .default({}),
});

export type Config = z.output<typeof ConfigSchema>;
export type TranslatorConfig = Config["translator"];
export type Effort = z.output<typeof effort>;
