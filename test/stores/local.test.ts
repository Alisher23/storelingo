import { describe, expect, it } from "vitest";
import { readLocalListings } from "../../src/stores/local.js";
import { makeProject } from "../helpers/project.js";

const P = "fastlane/metadata/android";
const A = "fastlane/metadata";
const playConfig = {
  sourceLocale: "en-US",
  targetLocales: ["ru", "ky"],
  stores: { play: { packageName: "com.example" } },
  translator: { provider: "anthropic" },
};

describe("readLocalListings", () => {
  it("reads non-empty play fields for source and target locales", async () => {
    const { cwd, config } = await makeProject(
      {
        [`${P}/en-US/title.txt`]: "Prayer Times\n",
        [`${P}/en-US/short_description.txt`]: "Accurate",
        [`${P}/en-US/full_description.txt`]: "   \n",
        [`${P}/en-US/video.txt`]: "https://youtu.be/x",
        [`${P}/en-US/changelogs/5.txt`]: "Bug fixes",
        [`${P}/ru-RU/title.txt`]: "Время намаза",
        [`${P}/de-DE/title.txt`]: "not a configured target",
      },
      playConfig,
    );
    expect(await readLocalListings(config, cwd, "play")).toEqual([
      {
        locale: "en-US",
        fields: { title: "Prayer Times", short_description: "Accurate", video: "https://youtu.be/x" },
      },
      { locale: "ru-RU", fields: { title: "Время намаза" } },
    ]);
  });

  it("uses App Store codes and includes keywords", async () => {
    const { cwd, config } = await makeProject(
      {
        [`${A}/en-US/name.txt`]: "Prayer Times",
        [`${A}/en-US/keywords.txt`]: "quran,qibla",
        [`${A}/ru/name.txt`]: "Время намаза",
      },
      { ...playConfig, stores: { appstore: { appId: "1" } } },
    );
    expect(await readLocalListings(config, cwd, "appstore")).toEqual([
      { locale: "en-US", fields: { name: "Prayer Times", keywords: "quran,qibla" } },
      { locale: "ru", fields: { name: "Время намаза" } },
    ]);
  });
});
