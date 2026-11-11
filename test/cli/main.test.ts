import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { main, type CliDeps } from "../../src/cli/main.js";
import { StorelingoError } from "../../src/errors.js";
import type { Translator } from "../../src/translate/types.js";
import { fakeStore } from "../helpers/fake-store.js";
import { makeProject } from "../helpers/project.js";
import { makeTmpDir } from "../helpers/tmp.js";

const P = "fastlane/metadata/android";
const config = {
  sourceLocale: "en-US",
  targetLocales: ["ru"],
  stores: { play: { packageName: "com.example" } },
  translator: { provider: "anthropic" },
};
const files = {
  "storelingo.config.json": JSON.stringify(config),
  [`${P}/en-US/title.txt`]: "Prayer Times",
  [`${P}/en-US/short_description.txt`]: "Accurate",
  [`${P}/en-US/full_description.txt`]: "Long",
};

const echoTranslator: Translator = {
  translate: async (req) => ({
    texts: Object.fromEntries(req.fields.map((f) => [f.key, `RU ${f.text}`])),
    errors: {},
    usage: { inputTokens: 5, outputTokens: 1 },
  }),
};

function deps(cwd: string, extra: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const d: CliDeps = {
    cwd,
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    makeTranslator: () => echoTranslator,
    ...extra,
  };
  return { d, out, err };
}

const run = (d: CliDeps, ...args: string[]) => main(["node", "storelingo", ...args], d);

describe("cli", () => {
  it("check passes with warnings before translation, translate fills the gaps", async () => {
    const { cwd } = await makeProject(files, config);
    const first = deps(cwd);
    expect(await run(first.d, "check")).toBe(0); // missing translations are warnings only
    expect(first.err.join("\n")).toContain("not translated yet");

    const t = deps(cwd);
    expect(await run(t.d, "translate")).toBe(0);
    expect(t.out.join("\n")).toContain("Translated 3 fields");
    expect(await readFile(join(cwd, P, "ru-RU", "title.txt"), "utf8")).toBe("RU Prayer Times");
  });

  it("check returns 1 on errors", async () => {
    const { cwd } = await makeProject({ ...files, [`${P}/en-US/title.txt`]: "x".repeat(31) }, config);
    const { d, err } = deps(cwd);
    expect(await run(d, "check")).toBe(1);
    expect(err.join("\n")).toContain("error play/en-US/title: 31 characters, limit is 30");
  });

  it("returns 2 with a hint when the config is missing", async () => {
    const cwd = await makeTmpDir();
    const { d, err } = deps(cwd);
    expect(await run(d, "check")).toBe(2);
    expect(err.join("\n")).toContain("E_CONFIG");
    expect(err.join("\n")).toContain("npx storelingo init");
  });

  it("supports --config with a relative path", async () => {
    const { cwd } = await makeProject({ ...files, "conf/sl.json": JSON.stringify(config) }, config);
    const { d } = deps(cwd);
    expect(await run(d, "--config", "conf/sl.json", "check")).toBe(0);
  });

  it("init uses the prompt and writes files", async () => {
    const cwd = await makeTmpDir();
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    const { d, out } = deps(cwd, {
      promptInit: async () => ({
        sourceLocale: "en-US",
        targetLocales: ["de"],
        playPackageName: "a.b",
        provider: "anthropic",
        context: "",
      }),
    });
    expect(await run(d, "init")).toBe(0);
    expect(out.join("\n")).toContain("created storelingo.config.json");
    expect(out.join("\n")).toContain("updated .gitignore");
    expect(out.join("\n")).not.toContain("created .gitignore");
  });

  it("translate returns 1 when some fields failed", async () => {
    const { cwd } = await makeProject(files, config);
    const failing: Translator = {
      translate: async () => ({ texts: {}, errors: { title: "too long" }, usage: { inputTokens: 0, outputTokens: 0 } }),
    };
    const { d, err } = deps(cwd, { makeTranslator: () => failing });
    expect(await run(d, "translate")).toBe(1);
    expect(err.join("\n")).toContain("play/ru-RU/title: too long");
  });

  it("prints help with exit 0", async () => {
    const cwd = await makeTmpDir();
    const { d, out } = deps(cwd);
    expect(await run(d, "--help")).toBe(0);
    expect(out.join("\n")).toContain("translate");
  });

  it("masks the third translator key variable in logs", async () => {
    const { cwd } = await makeProject(files, config);
    const leaky: Translator = {
      translate: async () => ({
        texts: {},
        errors: { title: "bad key tr-secret-987654" },
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    };
    const { d, err } = deps(cwd, {
      env: { STORELINGO_TRANSLATOR_API_KEY: "tr-secret-987654" },
      makeTranslator: () => leaky,
    });
    expect(await run(d, "translate")).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("***");
    expect(text).not.toContain("tr-secret-987654");
  });

  it("masks secrets in top-level error output", async () => {
    const { cwd } = await makeProject(files, config);
    const { d, err } = deps(cwd, {
      env: { ANTHROPIC_API_KEY: "sk-ant-secret-123456" },
      makeTranslator: () => {
        throw new StorelingoError("E_CONFIG", "bad key sk-ant-secret-123456", "check sk-ant-secret-123456");
      },
    });
    expect(await run(d, "translate")).toBe(2);
    const text = err.join("\n");
    expect(text).toContain("***");
    expect(text).not.toContain("sk-ant-secret-123456");
  });

  it("masks secrets in generic top-level errors", async () => {
    const { cwd } = await makeProject(files, config);
    const { d, err } = deps(cwd, {
      env: { ANTHROPIC_API_KEY: "sk-ant-secret-123456" },
      makeTranslator: () => {
        throw new Error("boom sk-ant-secret-123456");
      },
    });
    await run(d, "translate");
    expect(err.join("\n")).not.toContain("sk-ant-secret-123456");
  });

  it("init prints a hint naming the API key env vars", async () => {
    const cwd = await makeTmpDir();
    const { d, out } = deps(cwd, {
      promptInit: async () => ({
        sourceLocale: "en-US",
        targetLocales: ["de"],
        playPackageName: "a.b",
        provider: "anthropic",
        context: "",
      }),
    });
    expect(await run(d, "init")).toBe(0);
    expect(out.join("\n")).toContain("STORELINGO_TRANSLATOR_API_HOST");
  });
});

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
const remoteListings = [
  { locale: "en-US", fields: { title: "Old", short_description: "Accurate", full_description: "Long" } },
];

function storeDeps(cwd: string, extra: Partial<CliDeps> = {}) {
  const fake = fakeStore(remoteListings);
  const makeStore = vi.fn(async () => fake.client);
  const d = deps(cwd, { makeStore, isTTY: false, ...extra });
  return { ...d, fake, makeStore };
}

describe("pull/push", () => {
  it("prints the version from package.json", async () => {
    const { d, out } = deps(await makeTmpDir());
    expect(await run(d, "--version")).toBe(0);
    expect(out.join("\n")).toContain(pkg.version);
  });

  it("pull writes files and summarizes", async () => {
    const { cwd } = await makeProject({ "storelingo.config.json": JSON.stringify(config) }, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "pull")).toBe(0);
    expect(await readFile(join(cwd, P, "en-US", "title.txt"), "utf8")).toBe("Old");
    expect(s.out.join("\n")).toContain("Pulled from Google Play: wrote 3");
  });

  it("push without --yes outside a terminal exits 2 before any network call", async () => {
    const { cwd } = await makeProject(files, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "push")).toBe(2);
    expect(s.err.join("\n")).toContain("--yes");
    expect(s.makeStore).not.toHaveBeenCalled();
  });

  it("push --yes uploads and reports", async () => {
    const { cwd } = await makeProject(files, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "push", "--yes")).toBe(0);
    expect(s.out.join("\n")).toContain("Pushed 1 listing(s) to Google Play: en-US");
    expect(s.fake.state.committed).toBe(1);
  });

  it("push --dry-run works without a terminal and changes nothing", async () => {
    const { cwd } = await makeProject(files, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "push", "--dry-run")).toBe(0);
    expect(s.out.join("\n")).toContain("Dry run: nothing was changed.");
    expect(s.fake.state.committed).toBe(0);
  });

  it("push uses deps.confirm and respects a no", async () => {
    const { cwd } = await makeProject(files, config);
    const confirm = vi.fn(async () => false);
    const s = storeDeps(cwd, { confirm });
    expect(await run(s.d, "push")).toBe(0);
    expect(confirm).toHaveBeenCalledWith("Upload these changes to Google Play?");
    expect(s.out.join("\n")).toContain("Cancelled: nothing was changed.");
  });

  it("push blocked by check errors exits 1", async () => {
    const { cwd } = await makeProject({ ...files, [`${P}/en-US/title.txt`]: "x".repeat(31) }, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "push", "--yes")).toBe(1);
    expect(s.err.join("\n")).toContain("Push blocked");
  });

  it("--store appstore with a play-only config is a config error", async () => {
    const { cwd } = await makeProject(files, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "push", "--store", "appstore", "--yes")).toBe(2);
    expect(s.err.join("\n")).toContain("stores.appstore is not configured");
    expect(s.makeStore).not.toHaveBeenCalled();
  });

  it("--store foo is a usage error before any network call", async () => {
    const { cwd } = await makeProject(files, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "pull", "--store", "foo")).toBe(2);
    expect(s.err.join("\n")).toContain('--store must be play or appstore, got "foo"');
    expect(s.makeStore).not.toHaveBeenCalled();
  });

  it("--store appstore pulls via the appstore store", async () => {
    const appOnly = { ...config, stores: { appstore: { appId: "123", platform: "IOS" } } };
    const { cwd } = await makeProject({ "storelingo.config.json": JSON.stringify(appOnly) }, appOnly);
    const fake = fakeStore([{ locale: "en-US", fields: { name: "Prayer Times" } }], { store: "appstore" });
    const makeStore = vi.fn(async () => fake.client);
    const s = deps(cwd, { makeStore, isTTY: false });
    expect(await run(s.d, "pull", "--store", "appstore")).toBe(0);
    expect(makeStore).toHaveBeenCalledWith("appstore", expect.anything(), expect.anything());
    expect(await readFile(join(cwd, "fastlane/metadata/en-US/name.txt"), "utf8")).toBe("Prayer Times");
    expect(s.out.join("\n")).toContain("Pulled from App Store");
  });

  describe("both stores configured", () => {
    const both = {
      ...config,
      stores: { play: { packageName: "com.example" }, appstore: { appId: "123", platform: "IOS" } },
    };
    const bothFiles = {
      ...files,
      "storelingo.config.json": JSON.stringify(both),
      "fastlane/metadata/en-US/name.txt": "Prayer Times",
      "fastlane/metadata/en-US/description.txt": "Long",
      "fastlane/metadata/en-US/keywords.txt": "prayer,times",
    };
    const setup = async (projectFiles: Record<string, string>, extra: Partial<CliDeps> = {}) => {
      const { cwd } = await makeProject(projectFiles, both);
      const play = fakeStore(remoteListings);
      const app = fakeStore([{ locale: "en-US", fields: { name: "Old" } }], { store: "appstore" });
      const makeStore = vi.fn(async (store: string) => (store === "play" ? play.client : app.client));
      const d = deps(cwd, { makeStore, isTTY: false, ...extra });
      return { ...d, play, app, makeStore };
    };

    it("runs play then appstore and asks once per store", async () => {
      const confirm = vi.fn<(message: string) => Promise<boolean>>(async () => true);
      const s = await setup(bothFiles, { confirm });
      expect(await run(s.d, "push")).toBe(0);
      expect(s.makeStore.mock.calls.map((c) => c[0])).toEqual(["play", "appstore"]);
      expect(confirm.mock.calls.map((c) => c[0])).toEqual([
        "Upload these changes to Google Play?",
        "Upload these changes to App Store?",
      ]);
      expect(s.out.join("\n")).toContain("Updated 1 App Store localization(s): en-US.");
    });

    it("builds every store client before touching any store", async () => {
      const s = await setup(bothFiles);
      s.makeStore.mockImplementation(async (store: string) => {
        if (store === "appstore") throw new StorelingoError("E_CONFIG", "STORELINGO_ASC_ISSUER_ID not set");
        return s.play.client;
      });
      expect(await run(s.d, "push", "--yes")).toBe(2);
      expect(s.play.state.opened).toBe(0);
      expect(s.err.join(String.fromCharCode(10))).toContain("STORELINGO_ASC_ISSUER_ID not set");
    });

    it("builds every store client before pulling from any store", async () => {
      const s = await setup(bothFiles);
      s.makeStore.mockImplementation(async (store: string) => {
        if (store === "appstore") throw new StorelingoError("E_CONFIG", "no key");
        return s.play.client;
      });
      expect(await run(s.d, "pull")).toBe(2);
      expect(s.play.state.opened).toBe(0);
    });

    it("exits 1 when the App Store push is blocked even if Play succeeded", async () => {
      const s = await setup({ ...bothFiles, "fastlane/metadata/en-US/name.txt": "x".repeat(31) });
      expect(await run(s.d, "push", "--yes")).toBe(1);
      expect(s.play.state.committed).toBe(1);
      expect(s.err.join("\n")).toContain("Push blocked");
    });
  });

  it("masks STORELINGO_ASC_PRIVATE_KEY in error output", async () => {
    const { cwd } = await makeProject(files, config);
    const secret = "asc-private-key-body-456";
    const makeStore = vi.fn(async () => {
      throw new StorelingoError("E_STORE", `boom ${secret} boom`);
    });
    const s = storeDeps(cwd, { makeStore, env: { STORELINGO_ASC_PRIVATE_KEY: secret } });
    expect(await run(s.d, "push", "--yes")).toBe(1);
    expect(s.err.join("\n")).not.toContain(secret);
    expect(s.err.join("\n")).toContain("***");
  });

  it("E_IN_REVIEW from the store exits 1 with its message", async () => {
    const { cwd } = await makeProject(files, config);
    const fake = fakeStore(remoteListings, { failOn: "commit" });
    const s = storeDeps(cwd, { makeStore: vi.fn(async () => fake.client) });
    expect(await run(s.d, "push", "--yes")).toBe(1);
    expect(s.err.join("\n")).toContain("error [E_IN_REVIEW]");
  });

  it("push --store play without stores.play is a config error", async () => {
    const appOnly = { ...config, stores: { appstore: { appId: "1" } } };
    const { cwd } = await makeProject({ "storelingo.config.json": JSON.stringify(appOnly) }, appOnly);
    const s = storeDeps(cwd);
    expect(await run(s.d, "push", "--store", "play", "--yes")).toBe(2);
    expect(s.err.join("\n")).toContain("stores.play is not configured");
    expect(s.makeStore).not.toHaveBeenCalled();
  });

  it("masks STORELINGO_PLAY_SERVICE_ACCOUNT in error output", async () => {
    const { cwd } = await makeProject(files, config);
    const secret = "sa-secret-value-123";
    const makeStore = vi.fn(async () => {
      throw new StorelingoError("E_STORE", `boom ${secret} boom`);
    });
    const s = storeDeps(cwd, { makeStore, env: { STORELINGO_PLAY_SERVICE_ACCOUNT: secret } });
    expect(await run(s.d, "push", "--yes")).toBe(1);
    const text = s.err.join("\n");
    expect(text).toContain("***");
    expect(text).not.toContain(secret);
  });
});
