import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createWorldReader } from "./src/world-read.js";
import { ripgrepArgv, detectRipgrep } from "./src/world-read-files.js";
import { defaultSpawn } from "./src/world-read-spawn.js";

const root = await mkdtemp(path.join(tmpdir(), "wr-probe-src-"));
await mkdir(path.join(root, "src"), { recursive: true });
await writeFile(path.join(root, "README.md"), "# readme\nfindme here\n", "utf8");
await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n// findme in a.ts\n", "utf8");

const available = await detectRipgrep(defaultSpawn, root);
console.log("rg available:", available);
console.log("argv:", JSON.stringify(ripgrepArgv("findme", undefined)));

const direct = await defaultSpawn(
  "rg",
  ripgrepArgv("findme", undefined),
  { cwd: root, timeoutMs: 10000, stdoutLimitBytes: 10 * 1024 * 1024, stderrLimitBytes: 1024 * 1024 },
);
console.log("direct exit:", direct.exitCode, "stdout bytes:", direct.stdout.length);
console.log("direct stdout head:", JSON.stringify(direct.stdout.slice(0, 300)));
console.log("direct stderr:", JSON.stringify(direct.stderr.slice(0, 300)));

const reader = createWorldReader({ workspaceRoot: root, worldCwd: root });
console.log("op grep:", JSON.stringify(await reader.executeWorldRead("grep", ["findme"])));
console.log("op glob:", JSON.stringify(await reader.executeWorldRead("glob", ["**/*.ts"])));
