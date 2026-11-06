import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPull } from "../../src/commands/pull.js";
import { createLogger } from "../../src/log.js";
import type { StoreListing } from "../../src/stores/types.js";
import type { PlayApi } from "../../src/stores/google-play/client.js";
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
const remote: StoreListing[] = [
  { locale: "en-US", fields: { title: "Prayer Times", short_description: "Accurate", full_description: "Long" } },
  { locale: "bg", fields: { title: "Молитва" } },
];

function capture() {
  const warnings: string[] = [];
  const log = createLogger({ verbose: false, secrets: [], out: () => {}, err: (l) => warnings.push(l) });
  return { log, warnings };
}

describe("runPull", () => {
  it("writes every field of every listing, including languages outside the table", async () => {
    const { cwd, config: cfg } = await makeProject({}, config);
    const { client, state } = fakeStore(remote);
    const { log, warnings } = capture();
    const report = await runPull({ config: cfg, cwd, client, log });

    expect(report).toEqual({ written: 4, unchanged: 0, skipped: [], unknownLocales: ["bg"] });
    expect(await readFile(join(cwd, P, "en-US", "title.txt"), "utf8")).toBe("Prayer Times");
    expect(await readFile(join(cwd, P, "bg", "title.txt"), "utf8")).toBe("Молитва");
    expect(warnings.join("\n")).toContain("bg");
    expect(state).toMatchObject({ opened: 1, aborted: 1, committed: 0 });
  });

  it("counts identical files as unchanged, ignoring trailing newlines", async () => {
    const { cwd, config: cfg } = await makeProject({ [`${P}/en-US/title.txt`]: "Prayer Times\n" }, config);
    const report = await runPull({ config: cfg, cwd, client: fakeStore(remote).client, log: capture().log });
    expect(report.unchanged).toBe(1);
    expect(report.written).toBe(3);
  });

  it("counts a CRLF remote value equal to the LF local file as unchanged", async () => {
    const { cwd, config: cfg } = await makeProject({ [`${P}/en-US/full_description.txt`]: "Long\ntext" }, config);
    const api: PlayApi = {
      insertEdit: async () => "e1",
      listListings: async () => [{ language: "en-US", fullDescription: "Long\r\ntext" }],
      updateListing: async () => {},
      validateEdit: async () => {},
      commitEdit: async () => {},
      deleteEdit: async () => {},
    };
    const report = await runPull({ config: cfg, cwd, client: createPlayStore(api), log: capture().log });
    expect(report).toMatchObject({ written: 0, unchanged: 1 });
  });

  it("keeps a different local file unless --force", async () => {
    const files = { [`${P}/en-US/title.txt`]: "My local title" };
    const first = await makeProject(files, config);
    const kept = await runPull({ config: first.config, cwd: first.cwd, client: fakeStore(remote).client, log: capture().log });
    expect(kept.skipped).toEqual(["en-US/title.txt"]);
    expect(await readFile(join(first.cwd, P, "en-US", "title.txt"), "utf8")).toBe("My local title");

    const forced = await runPull({
      config: first.config,
      cwd: first.cwd,
      client: fakeStore(remote).client,
      log: capture().log,
      force: true,
    });
    expect(forced.skipped).toEqual([]);
    expect(await readFile(join(first.cwd, P, "en-US", "title.txt"), "utf8")).toBe("Prayer Times");
  });

  it("overwrites a blank local file without --force", async () => {
    const { cwd, config: cfg } = await makeProject({ [`${P}/en-US/title.txt`]: "  \n" }, config);
    const report = await runPull({ config: cfg, cwd, client: fakeStore(remote).client, log: capture().log });
    expect(report.skipped).toEqual([]);
    expect(await readFile(join(cwd, P, "en-US", "title.txt"), "utf8")).toBe("Prayer Times");
  });

  it("skips unsafe language codes", async () => {
    const { cwd, config: cfg } = await makeProject({}, config);
    const { log, warnings } = capture();
    const report = await runPull({
      config: cfg,
      cwd,
      client: fakeStore([{ locale: "../evil", fields: { title: "x" } }]).client,
      log,
    });
    expect(report.written).toBe(0);
    expect(warnings.join("\n")).toContain("../evil");
    await expect(access(join(cwd, "fastlane", "metadata", "evil"))).rejects.toThrow();
  });

  it("never touches the lock file", async () => {
    const { cwd, config: cfg } = await makeProject({}, config);
    await runPull({ config: cfg, cwd, client: fakeStore(remote).client, log: capture().log });
    await expect(access(join(cwd, "storelingo.lock.json"))).rejects.toThrow();
  });

  it("aborts the session even when reading listings fails", async () => {
    const { cwd, config: cfg } = await makeProject({}, config);
    const { client, state } = fakeStore(remote);
    const failing = {
      store: client.store,
      async open() {
        const session = await client.open();
        return { ...session, listings: async () => Promise.reject(new Error("boom")) };
      },
    };
    await expect(runPull({ config: cfg, cwd, client: failing, log: capture().log })).rejects.toThrow("boom");
    expect(state.aborted).toBe(1);
  });
});
