import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAsyncSubagentsConfig } from "../src/config.js";
import { buildPiCommand, childControlExtensionPath } from "../src/piHarness.js";
import { startSubagent } from "../src/start.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "async-subagents-default-ext-"));
}

function writeConfig(home: string, config: unknown): void {
  mkdirSync(join(home, ".async-subagents"), { recursive: true });
  writeFileSync(join(home, ".async-subagents", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function makeFile(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "export default {};\n");
  return path;
}

test("loadAsyncSubagentsConfig loads approved absolute default extensions and dedupes realpaths", () => {
  const root = tempRoot();
  const home = join(root, "home");
  const project = join(root, "repo");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), "{}\n");
  const extension = makeFile(join(project, "extensions", "pi", "index.ts"));
  const link = join(root, "linked-extension.ts");
  symlinkSync(extension, link);
  writeConfig(home, {
    version: 1,
    defaultExtensions: [
      { path: extension, approved: true },
      { path: link, approved: true },
    ],
  });

  const config = loadAsyncSubagentsConfig({ cwd: project, env: { HOME: home } as NodeJS.ProcessEnv });
  assert.equal(config.defaultExtensions.length, 1);
  assert.equal(config.defaultExtensions[0]?.realPath, extension);
  assert.equal(config.defaultExtensions[0]?.projectLocal, true);
  assert.deepEqual(config.defaultExtensions[0]?.tools, []);
});

test("loadAsyncSubagentsConfig rejects unapproved, unknown, relative, nonexistent, and invalid tool entries", () => {
  const cases: Array<{ name: string; config: unknown; message: RegExp }> = [
    { name: "unknown root key", config: { version: 1, extra: true }, message: /unknown key extra/ },
    { name: "unknown entry key", config: { version: 1, defaultExtensions: [{ path: "/tmp/nope", approved: true, extra: true }] }, message: /unknown key extra/ },
    { name: "unapproved", config: { version: 1, defaultExtensions: [{ path: "/tmp/nope", approved: false }] }, message: /approved: true/ },
    { name: "relative", config: { version: 1, defaultExtensions: [{ path: "./extension.ts", approved: true }] }, message: /absolute path/ },
    { name: "nonexistent", config: { version: 1, defaultExtensions: [{ path: "/tmp/async-subagents-missing-extension.ts", approved: true }] }, message: /does not exist/ },
    { name: "invalid tools", config: { version: 1, defaultExtensions: [{ path: "/tmp/nope", approved: true, tools: ["bad/tool"] }] }, message: /does not exist|tools must be an array/ },
  ];
  for (const item of cases) {
    const root = tempRoot();
    const home = join(root, "home");
    writeConfig(home, item.config);
    assert.throws(() => loadAsyncSubagentsConfig({ env: { HOME: home } as NodeJS.ProcessEnv }), item.message, item.name);
  }

  const root = tempRoot();
  const home = join(root, "home");
  const directory = join(root, "extension-dir");
  mkdirSync(directory, { recursive: true });
  writeConfig(home, { version: 1, defaultExtensions: [{ path: directory, approved: true, tools: ["ranked_search"] }] });
  const config = loadAsyncSubagentsConfig({ env: { HOME: home } as NodeJS.ProcessEnv });
  assert.equal(config.defaultExtensions[0]?.realPath, directory);
  assert.deepEqual(config.defaultExtensions[0]?.tools, ["ranked_search"]);
});

test("startSubagent logs default extension provenance for launched children", async () => {
  const root = tempRoot();
  const home = join(root, "home");
  const project = join(root, "repo");
  mkdirSync(join(project, ".agents"), { recursive: true });
  writeFileSync(join(project, "package.json"), "{}\n");
  writeFileSync(
    join(project, ".agents", "scout.md"),
    `---
description: Scout.
tools: []
extensions: []
---

Scout body.
`,
  );
  const extension = makeFile(join(project, "extensions", "pi", "index.ts"));
  writeConfig(home, { version: 1, defaultExtensions: [{ path: extension, approved: true, tools: ["ranked_search"] }] });

  const started = await startSubagent({
    agent: "scout",
    task: "Use default extension",
    cwd: project,
    runRoot: join(root, "runs"),
    parentRunId: "root_default_ext",
    fake: { mode: "immediate", body: "done" },
    env: { HOME: home },
  });
  const launch = JSON.parse(readFileSync(join(started.runDir, "logs", "launch.json"), "utf8"));
  assert.equal(launch.defaultExtensionsConfigPath, join(home, ".async-subagents", "config.json"));
  assert.equal(launch.defaultExtensions[0].realPath, extension);
  assert.equal(launch.defaultExtensions[0].source, "user-config");
  assert.equal(launch.defaultExtensions[0].projectLocal, true);
  assert.deepEqual(launch.defaultExtensions[0].tools, ["ranked_search"]);
  assert.deepEqual(launch.defaultExtensionTools, ["ranked_search"]);
  const extensions = launch.args.flatMap((arg: string, index: number, args: string[]) => (arg === "-e" ? [args[index + 1]] : [])).filter(Boolean);
  assert.equal(extensions[0], extension);
});

test("buildPiCommand places default extensions before agent extensions and dedupes realpaths", () => {
  const root = tempRoot();
  const defaultExtension = makeFile(join(root, "default.ts"));
  const linkToDefault = join(root, "default-link.ts");
  symlinkSync(defaultExtension, linkToDefault);
  const agentExtension = makeFile(join(root, "agent.ts"));
  const command = buildPiCommand({
    systemPath: "/run/artifacts/system.md",
    taskPath: "/run/artifacts/task.md",
    runDir: "/run",
    cwd: "/repo",
    sessionPolicy: "record",
    userBuiltinTools: [],
    skills: [],
    defaultExtensionPaths: [defaultExtension],
    defaultExtensionTools: ["ranked_search"],
    extensions: [linkToDefault, agentExtension],
    runtimeExtensionPaths: [childControlExtensionPath],
  });
  const extensions = command.args.flatMap((arg, index, args) => (arg === "-e" ? [args[index + 1]] : [])).filter((value): value is string => Boolean(value));
  assert.deepEqual(extensions.slice(0, 2), [defaultExtension, agentExtension]);
  assert.equal(extensions.includes(linkToDefault), false);
  const toolsIndex = command.args.indexOf("--tools");
  assert.match(command.args[toolsIndex + 1] ?? "", /ranked_search/);
});
