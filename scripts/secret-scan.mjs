import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
const paths = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/,
];
const flagged = [];
for (const path of paths) {
  if (/\.(?:png|svg)$/.test(path)) continue;
  if (
    /\.sqlite(?:-|$)|(?:^|\/)options\.json$|(?:^|\/)\.env$|(?:^|\/)(?:runtime|\.pi|\.local)\//.test(
      path,
    )
  ) {
    flagged.push(path);
    continue;
  }
  if ((await stat(path)).size > 2097152) {
    flagged.push(path);
    continue;
  }
  const content = await readFile(path, "utf8");
  // Deliberately named synthetic test credentials are not production credentials.
  const sanitized = content.replace(/sk-synthetic-[a-z-]+/g, "SYNTHETIC");
  if (patterns.some((pattern) => pattern.test(sanitized))) flagged.push(path);
}
if (flagged.length) {
  console.error(`Secret scan requires review of: ${flagged.join(", ")}`);
  process.exit(1);
}
console.log(
  `Local secret-pattern scan: ${paths.length} public files checked. This is not a security audit.`,
);
