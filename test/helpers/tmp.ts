import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "storelingo-"));
}

/**
 * Creates a symlink, or returns false where the OS does not allow it (Windows without
 * Developer Mode gives EPERM for file symlinks). "junction" links a directory and works
 * on Windows without extra rights; on Linux/macOS it is an ordinary symlink.
 */
export async function trySymlink(target: string, path: string, type?: "file" | "dir" | "junction"): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  }
}
