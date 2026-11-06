import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { imageUrlViolations } from "./imageUrlOwnership";

const paths = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((path) => /\.(?:[jt]sx?|swift|kt)$/.test(path));

let count = 0;
for (const path of new Set(paths)) {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
    throw error;
  }
  const violations = imageUrlViolations(source, path);
  for (const { line, message } of violations) {
    console.error(`${path}:${line}: ${message}`);
    count++;
  }
}

if (count > 0) process.exitCode = 1;
else console.log("Jellyfin image URL ownership check passed");
