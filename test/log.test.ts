import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";

function capture(verbose: boolean, secrets: (string | undefined)[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const log = createLogger({ verbose, secrets, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { log, out, err };
}

describe("createLogger", () => {
  it("writes info to out and warn/error to err", () => {
    const { log, out, err } = capture(false);
    log.info("hello");
    log.warn("careful");
    log.error("bad");
    expect(out).toEqual(["hello"]);
    expect(err).toEqual(["warning: careful", "error: bad"]);
  });
  it("prints debug only when verbose", () => {
    const quiet = capture(false);
    quiet.log.debug("detail");
    expect(quiet.out).toEqual([]);
    const loud = capture(true);
    loud.log.debug("detail");
    expect(loud.out).toEqual(["debug: detail"]);
  });
  it("masks secrets of 6+ characters and ignores undefined", () => {
    const { log, out } = capture(false, ["sk-ant-123456", undefined, "abc"]);
    log.info("key sk-ant-123456 and abc");
    expect(out).toEqual(["key *** and abc"]);
  });
});
