import { describe, expect, it, vi } from "vitest";
import { runPush } from "../../src/commands/push.js";
import { createLogger } from "../../src/log.js";
import { fakeStore } from "../helpers/fake-store.js";
import { makeProject } from "../helpers/project.js";

const P = "fastlane/metadata/android";
const config = {
  sourceLocale: "en-US",
  targetLocales: ["ru"],
  stores: { play: { packageName: "com.example" } },
  translator: { provider: "anthropic" },
};
const source = {
  [`${P}/en-US/title.txt`]: "New title",
  [`${P}/en-US/short_description.txt`]: "S",
  [`${P}/en-US/full_description.txt`]: "F",
};
const remote = [
  { locale: "en-US", fields: { title: "Old title", short_description: "S", full_description: "F", video: "v" } },
];

function capture() {
  const out: string[] = [];
  const log = createLogger({ verbose: false, secrets: [], out: (l) => out.push(l), err: (l) => out.push(l) });
  return { log, out };
}
const yes = vi.fn(async () => true);

describe("runPush", () => {
  it("is blocked by check errors before touching the store", async () => {
    const { cwd, config: cfg } = await makeProject({ ...source, [`${P}/en-US/title.txt`]: "x".repeat(31) }, config);
    const { client, state } = fakeStore(remote);
    const report = await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes });
    expect(report.status).toBe("blocked");
    expect(report.problems.join("\n")).toContain("31 characters, limit is 30");
    expect(state.opened).toBe(0);
  });

  it("reports nothing to push when the store matches", async () => {
    const { cwd, config: cfg } = await makeProject({ ...source, [`${P}/en-US/title.txt`]: "Old title\n" }, config);
    const { client, state } = fakeStore(remote);
    const { log, out } = capture();
    const report = await runPush({ config: cfg, cwd, client, log, confirm: yes });
    expect(report).toEqual({ status: "nothing", locales: [], problems: [] });
    expect(out.join("\n")).toContain("Nothing to push");
    expect(state).toMatchObject({ aborted: 1, committed: 0 });
  });

  it("dry run prints the diff and changes nothing", async () => {
    const { cwd, config: cfg } = await makeProject(source, config);
    const { client, state } = fakeStore(remote);
    const { log, out } = capture();
    const confirm = vi.fn(async () => true);
    const report = await runPush({ config: cfg, cwd, client, log, dryRun: true, confirm });
    expect(report).toEqual({ status: "dry-run", locales: ["en-US"], problems: [] });
    expect(out).toContain('  title: "Old title" → "New title"');
    expect(confirm).not.toHaveBeenCalled();
    expect(state).toMatchObject({ updates: [], aborted: 1, committed: 0 });
  });

  it("does nothing when the user declines", async () => {
    const { cwd, config: cfg } = await makeProject(source, config);
    const { client, state } = fakeStore(remote);
    const report = await runPush({ config: cfg, cwd, client, log: capture().log, confirm: async () => false });
    expect(report.status).toBe("cancelled");
    expect(state).toMatchObject({ updates: [], aborted: 1, committed: 0 });
  });

  it("pushes merged listings, including a new locale, and commits once", async () => {
    const { cwd, config: cfg } = await makeProject(
      {
        ...source,
        [`${P}/ru-RU/title.txt`]: "Время намаза",
        [`${P}/ru-RU/short_description.txt`]: "Точно",
        [`${P}/ru-RU/full_description.txt`]: "Длинно",
      },
      config,
    );
    const { client, state } = fakeStore(remote);
    const confirm = vi.fn(async () => true);
    const report = await runPush({ config: cfg, cwd, client, log: capture().log, confirm });

    expect(report).toEqual({ status: "pushed", locales: ["en-US", "ru-RU"], problems: [] });
    expect(confirm).toHaveBeenCalledWith(expect.arrayContaining(["en-US:", "ru-RU (new listing):"]));
    expect(state.updates).toEqual([
      { locale: "en-US", fields: { title: "New title", short_description: "S", full_description: "F", video: "v" } },
      { locale: "ru-RU", fields: { title: "Время намаза", short_description: "Точно", full_description: "Длинно" } },
    ]);
    expect(state).toMatchObject({ committed: 1, aborted: 0 });
  });

  it("blocks a new locale that lacks required fields", async () => {
    const { cwd, config: cfg } = await makeProject({ ...source, [`${P}/ru-RU/title.txt`]: "Время" }, config);
    const { client, state } = fakeStore(remote);
    const report = await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes });
    expect(report.status).toBe("blocked");
    expect(report.problems).toEqual(["ru-RU: a new listing needs short_description, full_description"]);
    expect(state).toMatchObject({ updates: [], aborted: 1 });
  });

  it("aborts and rethrows when an update fails", async () => {
    const { cwd, config: cfg } = await makeProject(source, config);
    const { client, state } = fakeStore(remote, { failOn: "update" });
    await expect(runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes })).rejects.toMatchObject({
      code: "E_STORE",
    });
    expect(state).toMatchObject({ committed: 0, aborted: 1 });
  });

  it("aborts and rethrows E_IN_REVIEW from commit", async () => {
    const { cwd, config: cfg } = await makeProject(source, config);
    const { client, state } = fakeStore(remote, { failOn: "commit" });
    await expect(runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes })).rejects.toMatchObject({
      code: "E_IN_REVIEW",
    });
    expect(state.aborted).toBe(1);
  });

  it("notes that changelogs are not uploaded", async () => {
    const { cwd, config: cfg } = await makeProject({ ...source, [`${P}/en-US/changelogs/12.txt`]: "Fixes" }, config);
    const { log, out } = capture();
    await runPush({ config: cfg, cwd, client: fakeStore(remote).client, log, dryRun: true, confirm: yes });
    expect(out.join("\n")).toContain("fastlane supply");
  });
});
