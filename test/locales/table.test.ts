import { describe, expect, it } from "vitest";
import { LOCALES, findLocale, fromStoreLocale, toStoreLocale } from "../../src/locales/table.js";

describe("locale table", () => {
  it("maps common codes to store codes", () => {
    expect(toStoreLocale("play", "ru")).toBe("ru-RU");
    expect(toStoreLocale("appstore", "ru")).toBe("ru");
    expect(toStoreLocale("play", "he")).toBe("iw-IL");
    expect(toStoreLocale("appstore", "he")).toBe("he");
    expect(toStoreLocale("play", "zh-Hans")).toBe("zh-CN");
    expect(toStoreLocale("appstore", "zh-Hans")).toBe("zh-Hans");
  });

  it("returns undefined where a store lacks the language", () => {
    expect(toStoreLocale("play", "ky")).toBe("ky-KG");
    expect(toStoreLocale("appstore", "ky")).toBeUndefined();
    expect(toStoreLocale("play", "xx")).toBeUndefined();
  });

  it("maps store codes back to common codes", () => {
    expect(fromStoreLocale("play", "de-DE")).toBe("de");
    expect(fromStoreLocale("appstore", "es-MX")).toBe("es-419");
    expect(fromStoreLocale("appstore", "nope")).toBeUndefined();
  });

  it("has unique common codes and unique store codes", () => {
    const codes = LOCALES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const store of ["play", "appstore"] as const) {
      const storeCodes = LOCALES.map((l) => l[store]).filter(Boolean);
      expect(new Set(storeCodes).size).toBe(storeCodes.length);
    }
  });

  it("gives every locale a human-readable name", () => {
    expect(findLocale("uz")?.name).toBe("Uzbek");
    expect(LOCALES.every((l) => l.name.length > 0)).toBe(true);
  });
});
