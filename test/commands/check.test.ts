import { describe, expect, it } from "vitest";
import { runCheck } from "../../src/commands/check.js";
import { makeProject } from "../helpers/project.js";

const P = "fastlane/metadata/android";
const A = "fastlane/metadata";

const complete = {
  [`${P}/en-US/title.txt`]: "Prayer Times\n",
  [`${P}/en-US/short_description.txt`]: "Accurate prayer times",
  [`${P}/en-US/full_description.txt`]: "Long text",
  [`${P}/ru-RU/title.txt`]: "Время намаза",
  [`${P}/ru-RU/short_description.txt`]: "Точное время",
  [`${P}/ru-RU/full_description.txt`]: "Длинный текст",
  [`${P}/ky-KG/title.txt`]: "Намаз убактысы",
  [`${P}/ky-KG/short_description.txt`]: "Так убакыт",
  [`${P}/ky-KG/full_description.txt`]: "Узун текст",
  [`${A}/en-US/name.txt`]: "Prayer Times",
  [`${A}/en-US/description.txt`]: "Long text",
  [`${A}/en-US/keywords.txt`]: "quran,qibla",
  [`${A}/ru/name.txt`]: "Время намаза",
  [`${A}/ru/description.txt`]: "Длинный текст",
  [`${A}/ru/keywords.txt`]: "коран,кибла",
};

describe("runCheck", () => {
  it("passes a complete project, warning only about unsupported locales", async () => {
    const { cwd, config } = await makeProject(complete);
    const issues = await runCheck(config, cwd);
    expect(issues).toEqual([
      {
        level: "warning",
        store: "appstore",
        locale: "ky",
        code: "E_LOCALE_UNSUPPORTED",
        message: "App Store does not support ky; skipped",
      },
    ]);
  });

  it("reports a missing required source field", async () => {
    const files: Record<string, string> = { ...complete };
    delete files[`${A}/en-US/name.txt`];
    const { cwd, config } = await makeProject(files);
    const issues = await runCheck(config, cwd);
    expect(issues).toContainEqual(
      expect.objectContaining({ level: "error", store: "appstore", locale: "en-US", field: "name", code: "E_MISSING" }),
    );
  });

  it("warns about untranslated fields", async () => {
    const files: Record<string, string> = { ...complete };
    delete files[`${P}/ru-RU/title.txt`];
    const { cwd, config } = await makeProject(files);
    expect(await runCheck(config, cwd)).toContainEqual(
      expect.objectContaining({ level: "warning", store: "play", locale: "ru-RU", field: "title", code: "W_MISSING" }),
    );
  });

  it("reports over-limit fields, ignoring trailing newlines", async () => {
    const { cwd, config } = await makeProject({
      ...complete,
      [`${P}/ru-RU/title.txt`]: "Очень длинное название приложения",
      [`${P}/en-US/title.txt`]: `${"x".repeat(30)}\n\n`,
    });
    const issues = (await runCheck(config, cwd)).filter((i) => i.code === "E_LIMIT");
    expect(issues).toEqual([
      expect.objectContaining({ store: "play", locale: "ru-RU", field: "title", message: "33 characters, limit is 30" }),
    ]);
  });

  it("reports badly formatted keywords", async () => {
    const { cwd, config } = await makeProject({ ...complete, [`${A}/ru/keywords.txt`]: "коран, кибла,коран" });
    expect(await runCheck(config, cwd)).toContainEqual(
      expect.objectContaining({ level: "error", locale: "ru", field: "keywords", code: "E_FORMAT" }),
    );
  });
});
