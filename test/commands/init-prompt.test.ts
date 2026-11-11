import { describe, expect, it, vi } from "vitest";

interface InputConfig {
  message: string;
  validate?: (value: string) => boolean | string;
}
const inputs: InputConfig[] = [];

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(async (c: { choices: { value: string }[]; default?: string }) => c.default ?? c.choices[0]!.value),
  checkbox: vi.fn(async (c: { message: string; choices: { value: string }[] }) =>
    c.message === "Stores" ? ["appstore"] : [c.choices[0]!.value],
  ),
  input: vi.fn(async (c: InputConfig) => {
    inputs.push(c);
    return "1234567890";
  }),
}));

describe("promptInitAnswers", () => {
  it("only accepts a numeric App Store app ID", async () => {
    const { promptInitAnswers } = await import("../../src/commands/init.js");
    const answers = await promptInitAnswers();
    expect(answers.appstoreAppId).toBe("1234567890");
    const prompt = inputs.find((i) => i.message.startsWith("App Store app ID"));
    expect(prompt?.validate).toBeTypeOf("function");
    expect(prompt!.validate!(" 1234567890 ")).toBe(true);
    expect(typeof prompt!.validate!("com.example.app")).toBe("string");
    expect(typeof prompt!.validate!("12a")).toBe("string");
    expect(typeof prompt!.validate!("")).toBe("string");
  });
});
