import { mkdir, chmod, chown, lstat } from "node:fs/promises";
import { join } from "node:path";
import { insist } from "./safety.js";
import type { Config } from "./config.js";

// Supervisor creates root-owned /data and options. Read options before this step;
// only known database files are reowned, then permanently drop root before work.
export async function dropAppPrivileges(config: Config): Promise<void> {
  process.umask(0o077);
  if (config.mode !== "ingress") {
    insist(process.getuid?.() !== 0, "local_root_rejected");
    return;
  }
  if (process.getuid?.() !== 0) return;
  await mkdir("/data", { recursive: true, mode: 0o700 });
  const directory = await lstat("/data");
  insist(
    directory.isDirectory() && !directory.isSymbolicLink(),
    "unsafe_data_directory",
  );
  await chown("/data", 1000, 1000);
  await chmod("/data", 0o700);
  for (const name of [
    "hearth.sqlite",
    "hearth.sqlite-wal",
    "hearth.sqlite-shm",
  ]) {
    const path = join("/data", name);
    const stat = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat) {
      insist(stat.isFile() && !stat.isSymbolicLink(), "unsafe_data_file");
      await chown(path, 1000, 1000);
      await chmod(path, 0o600);
    }
  }
  process.setgroups?.([]);
  process.setgid?.(1000);
  process.setuid?.(1000);
  insist(
    process.getuid?.() === 1000 && process.getgid?.() === 1000,
    "privilege_drop_failed",
  );
}
