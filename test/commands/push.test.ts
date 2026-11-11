import { describe, expect, it, vi } from "vitest";
import { runPush } from "../../src/commands/push.js";
import { createLogger } from "../../src/log.js";
import type { PlayApi, PlayListing } from "../../src/stores/google-play/client.js";
import { createPlayStore } from "../../src/stores/google-play/store.js";
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
    expect(report).toEqual({ status: "nothing", locales: [], problems: [], skipped: [] });
    expect(out.join("\n")).toContain("Nothing to push");
    expect(state).toMatchObject({ aborted: 1, committed: 0 });
  });

  it("dry run prints the diff and changes nothing", async () => {
    const { cwd, config: cfg } = await makeProject(source, config);
    const { client, state } = fakeStore(remote);
    const { log, out } = capture();
    const confirm = vi.fn(async () => true);
    const report = await runPush({ config: cfg, cwd, client, log, dryRun: true, confirm });
    expect(report).toEqual({ status: "dry-run", locales: ["en-US"], problems: [], skipped: [] });
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

    expect(report).toEqual({ status: "pushed", locales: ["en-US", "ru-RU"], problems: [], skipped: [] });
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

  it("logs the diff before asking for confirmation", async () => {
    const { cwd, config: cfg } = await makeProject(source, config);
    const order: string[] = [];
    const out: string[] = [];
    const log = createLogger({
      verbose: false,
      secrets: [],
      out: (l) => {
        order.push("log");
        out.push(l);
      },
      err: () => {},
    });
    const confirm = vi.fn(async () => {
      order.push("confirm");
      return false;
    });
    await runPush({ config: cfg, cwd, client: fakeStore(remote).client, log, confirm });
    expect(order.indexOf("confirm")).toBeGreaterThan(order.lastIndexOf("log"));
    expect(out).toContain('  title: "Old title" → "New title"');
  });

  it("aborts the session and rethrows when confirm rejects", async () => {
    const { cwd, config: cfg } = await makeProject(source, config);
    const { client, state } = fakeStore(remote);
    const confirm = async (): Promise<boolean> => {
      throw new Error("prompt closed");
    };
    await expect(runPush({ config: cfg, cwd, client, log: capture().log, confirm })).rejects.toThrow("prompt closed");
    expect(state).toMatchObject({ updates: [], aborted: 1, committed: 0 });
  });

  it("treats a CRLF remote value as equal to the LF local one", async () => {
    const { cwd, config: cfg } = await makeProject({ ...source, [`${P}/en-US/full_description.txt`]: "Long\ntext" }, config);
    const listings: PlayListing[] = [
      { language: "en-US", title: "New title", shortDescription: "S", fullDescription: "Long\r\ntext", video: "v" },
    ];
    const api: PlayApi = {
      insertEdit: async () => "e1",
      listListings: async () => listings,
      updateListing: async () => {},
      validateEdit: async () => {},
      commitEdit: async () => {},
      deleteEdit: async () => {},
    };
    const report = await runPush({ config: cfg, cwd, client: createPlayStore(api), log: capture().log, confirm: yes });
    expect(report.status).toBe("nothing");
  });
});

describe("runPush with App Store-like stores", () => {
  const A = "fastlane/metadata";
  const asConfig = { ...config, stores: { appstore: { appId: "1" } } };
  const asRemote = [
    { locale: "en-US", fields: { name: "N", description: "Old", keywords: "k", promotional_text: "Old promo" } },
  ];
  const asSource = {
    [`${A}/en-US/name.txt`]: "N",
    [`${A}/en-US/description.txt`]: "New description",
    [`${A}/en-US/keywords.txt`]: "k",
    [`${A}/en-US/promotional_text.txt`]: "New promo",
  };
  const twoLocales = {
    ...asSource,
    [`${A}/ru/name.txt`]: "Имя",
    [`${A}/ru/description.txt`]: "Описание",
    [`${A}/ru/keywords.txt`]: "к",
  };

  it("sends only writable fields and lists the rest as skipped", async () => {
    const { cwd, config: cfg } = await makeProject(asSource, asConfig);
    const { client, state } = fakeStore(asRemote, { store: "appstore", writable: (f) => f === "promotional_text" });
    const confirm = vi.fn(async () => true);
    const report = await runPush({ config: cfg, cwd, client, log: capture().log, confirm });
    const line = "en-US/description: skipped (the store can't take this field)";
    expect(report.status).toBe("pushed");
    expect(report.skipped).toEqual([line]);
    expect(state.updates).toEqual([
      { locale: "en-US", fields: { name: "N", description: "Old", keywords: "k", promotional_text: "New promo" } },
    ]);
    expect(confirm).toHaveBeenCalledWith(expect.arrayContaining([line]));
  });

  it("throws E_NO_EDITABLE_VERSION when nothing writable changed", async () => {
    const { cwd, config: cfg } = await makeProject(asSource, asConfig);
    const { client, state } = fakeStore(asRemote, { store: "appstore", writable: () => false });
    await expect(runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes })).rejects.toMatchObject({
      code: "E_NO_EDITABLE_VERSION",
    });
    expect(state).toMatchObject({ updates: [], aborted: 1, committed: 0 });
  });

  it("blocks a new locale whose required field cannot be written", async () => {
    const { cwd, config: cfg } = await makeProject(twoLocales, asConfig);
    const { client, state } = fakeStore(asRemote, { store: "appstore", writable: (f) => f === "promotional_text" });
    const report = await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes });
    expect(report.status).toBe("blocked");
    expect(report.problems).toEqual(["ru: a new listing needs an editable app info and version in App Store Connect"]);
    expect(state).toMatchObject({ updates: [], aborted: 1 });
  });

  it("logs session notes before the diff", async () => {
    const { cwd, config: cfg } = await makeProject(asSource, asConfig);
    const { client } = fakeStore(asRemote, { store: "appstore", notes: ["Editing version 1.2"] });
    const { log, out } = capture();
    await runPush({ config: cfg, cwd, client, log, dryRun: true, confirm: yes });
    expect(out[0]).toBe("Editing version 1.2");
    expect(out.indexOf("en-US:")).toBeGreaterThan(0);
  });

  it("reports partial progress for a non-atomic store", async () => {
    const { cwd, config: cfg } = await makeProject(twoLocales, asConfig);
    const { client } = fakeStore(asRemote, { store: "appstore", atomic: false, failOnLocale: "ru" });
    const err = await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "E_STORE", hint: expect.stringContaining("storelingo push") });
    expect((err as Error).message).toContain(
      "already applied: en-US; failed (may be partly applied): ru; not attempted: none",
    );
  });

  it("reports partial progress when the very first locale fails", async () => {
    const { cwd, config: cfg } = await makeProject(twoLocales, asConfig);
    const { client } = fakeStore(asRemote, { store: "appstore", atomic: false, failOnLocale: "en-US" });
    const err = await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "E_STORE", hint: expect.stringContaining("storelingo push") });
    expect((err as Error).message).toContain(
      "already applied: none; failed (may be partly applied): en-US; not attempted: ru",
    );
  });

  it("sends a non-atomic store only the changed fields", async () => {
    const { cwd, config: cfg } = await makeProject(asSource, asConfig);
    const { client, state } = fakeStore(asRemote, { store: "appstore", atomic: false });
    await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes });
    const fields = state.updates[0]!.fields;
    expect(fields).toEqual({ description: "New description", promotional_text: "New promo" });
  });

  it("does not send unchanged remote fields to a non-atomic store", async () => {
    const remoteWithMore = [{ locale: "en-US", fields: { name: "N", description: "Old", keywords: "k", subtitle: "Keep me" } }];
    const { cwd, config: cfg } = await makeProject({ [`${A}/en-US/name.txt`]: "N", [`${A}/en-US/description.txt`]: "New", [`${A}/en-US/keywords.txt`]: "k" }, asConfig);
    const { client, state } = fakeStore(remoteWithMore, { store: "appstore", atomic: false });
    await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes });
    expect(state.updates).toEqual([{ locale: "en-US", fields: { description: "New" } }]);
  });

  it("still sends the full merged listing to an atomic store", async () => {
    const { cwd, config: cfg } = await makeProject(source, config);
    const { client, state } = fakeStore(remote);
    await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes });
    expect(state.updates[0]!.fields).toMatchObject({ title: "New title", video: "v" });
  });

  it("uses the store's skip reason per field", async () => {
    const { cwd, config: cfg } = await makeProject(asSource, asConfig);
    const { client } = fakeStore(asRemote, {
      store: "appstore",
      writable: (f) => f === "promotional_text",
      skipReason: (f) => `reason for ${f}`,
    });
    const report = await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes });
    expect(report.skipped).toEqual(["en-US/description: skipped (reason for description)"]);
  });

  it("falls back to a generic reason without skipReason", async () => {
    const { cwd, config: cfg } = await makeProject(asSource, asConfig);
    const { client } = fakeStore(asRemote, { store: "appstore", writable: (f) => f === "promotional_text" });
    const report = await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes });
    expect(report.skipped).toContain("en-US/description: skipped (the store can't take this field)");
  });

  it("logs skipped lines before E_NO_EDITABLE_VERSION, also on --dry-run", async () => {
    const { cwd, config: cfg } = await makeProject(asSource, asConfig);
    const { client } = fakeStore(asRemote, { store: "appstore", writable: () => false });
    const { log, out } = capture();
    await expect(runPush({ config: cfg, cwd, client, log, dryRun: true, confirm: yes })).rejects.toMatchObject({
      code: "E_NO_EDITABLE_VERSION",
    });
    expect(out).toContain("en-US/description: skipped (the store can't take this field)");
  });

  it("leaves the error unchanged for an atomic store", async () => {
    const { cwd, config: cfg } = await makeProject(twoLocales, asConfig);
    const { client } = fakeStore(asRemote, { store: "appstore", failOnLocale: "ru" });
    const err = await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "E_STORE", message: "API error 400: boom for ru" });
  });
});
