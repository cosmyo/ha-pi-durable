import {
  mkdir,
  chmod,
  chown,
  lstat,
  writeFile,
  readFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
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
    "chatgpt-oauth.json",
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
  if (config.workspaceEnabled) {
    // ONLY this App's addon_config mapping, not Home Assistant's /config.
    const bridge = "/workspace_link/bridge";
    await mkdir(bridge, { recursive: true, mode: 0o750 });
    const directory = await lstat(bridge);
    insist(
      directory.isDirectory() && !directory.isSymbolicLink(),
      "unsafe_workspace_bridge",
    );
    const key = join(bridge, "key");
    await writeFile(key, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o440,
    }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    const stat = await lstat(key);
    insist(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        /^[a-f0-9]{64}$/.test(await readFile(key, "utf8")),
      "unsafe_workspace_key",
    );
    await chown(bridge, 1001, 1000);
    await chmod(bridge, 0o750);
    await chown(key, 1001, 1000);
    await chmod(key, 0o440);
  }
  process.setgroups?.([]);
  process.setgid?.(1000);
  process.setuid?.(1000);
  insist(
    process.getuid?.() === 1000 && process.getgid?.() === 1000,
    "privilege_drop_failed",
  );
}
