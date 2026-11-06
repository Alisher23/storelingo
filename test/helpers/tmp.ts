import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "storelingo-"));
}
