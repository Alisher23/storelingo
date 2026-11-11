import { posix, win32 } from "node:path";
import { z } from "zod";

/** A relative path that stays inside the project on every OS (no "/x", "C:\x", "C:x", "\\host" or ".." escapes). */
function staysInsideProject(p: string): boolean {
  if (posix.isAbsolute(p) || win32.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) return false;
  const normalized = posix.normalize(p.replace(/\\/g, "/"));
  return normalized !== ".." && !normalized.startsWith("../");
}

const projectPath = z.string().refine(staysInsideProject, {
  message: "must be a relative path inside the project (no absolute paths or ..)",
});

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const concurrency = z.number().int().min(1).max(16).default(4);

const localeList = z
  .array(z.string().min(1))
  .min(1)
  .superRefine((codes, ctx) => {
    const duplicates = [...new Set(codes.filter((c, i) => codes.indexOf(c) !== i))];
    if (duplicates.length > 0) {
      ctx.addIssue({ code: "custom", message: `duplicate locale(s): ${duplicates.join(", ")}` });
    }
  });

// Every object is strict: a misspelled key (e.g. glossary.doNotTranslte) is an error, not silently dropped.
export const ConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  sourceLocale: z.string().min(1),
  targetLocales: localeList,
  stores: z
    .strictObject({
      play: z.strictObject({ packageName: z.string().min(1) }).optional(),
      appstore: z
        .strictObject({
          appId: z.string().regex(/^\d+$/, "must be the numeric Apple ID of the app"),
          platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS"),
        })
        .optional(),
    })
    .refine((s) => s.play !== undefined || s.appstore !== undefined, {
      message: "configure at least one store (play or appstore)",
    }),
  translator: z.discriminatedUnion("provider", [
    z.strictObject({
      provider: z.literal("anthropic"),
      model: z.string().min(1).default("claude-opus-5-5"),
      effort: effort.default("medium"),
      concurrency,
    }),
    z.strictObject({
      provider: z.literal("openai-compatible"),
      baseUrl: z.string().url(),
      model: z.string().min(1),
      concurrency,
    }),
  ]),
  context: z.string().default(""),
  glossary: z
    .strictObject({
      doNotTranslate: z.array(z.string()).default([]),
      terms: z.record(z.string(), z.record(z.string(), z.string())).default({}),
    })
    .default({ doNotTranslate: [], terms: {} }),
  paths: z
    .strictObject({
      play: projectPath.optional(),
      appstore: projectPath.optional(),
    })
    .default({}),
});

export type Config = z.output<typeof ConfigSchema>;
export type TranslatorConfig = Config["translator"];
export type Effort = z.output<typeof effort>;
