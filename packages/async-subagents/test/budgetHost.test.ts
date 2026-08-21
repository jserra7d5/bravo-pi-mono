import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type Context } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SettingsManager, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { ASYNC_SUBAGENT_TOOL_NAMES, TASK_TOOL_NAMES } from "../extensions/pi/tools.js";
import { readBudgetAutoSwarmGlobalState } from "../src/budgetAutoSwarmState.js";
import { RunStore } from "../src/runStore.js";
import { TaskStore } from "../src/taskStore.js";

// Compiled test lives in dist/test; walk to the production TypeScript entrypoint
// so Pi's real source loader exercises the artifact declared by package.json.
const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../../extensions/pi/index.ts");
const BUDGET_BADGE = "\x1b[38;2;213;163;233mSWARM:auto\x1b[0m";
async function bounded<T>(promise: Promise<T>, ms = 8_000): Promise<T> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`host timeout after ${ms}ms`)), ms); })]); } finally { if (timer) clearTimeout(timer); } }

test("real Pi loader/session command activates task tools, persists state, and injects prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "budget-host-")), oldHome = process.env.HOME, oldPath = process.env.PATH; process.env.HOME = root;
  const bin = join(root, "bin"), calls = join(root, "pi-calls.log"); mkdirSync(bin);
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\ncase " $* " in\n  *" --list-models "*) printf 'provider model context max-out thinking images\\nbravo-codex-balanced gpt-5.6-luna 128k 32k yes no\\nbravo-codex-balanced gpt-5.6-sol 128k 32k yes no\\nantigravity-code-assist gemini-3.5-flash 128k 32k yes no\\n' ;;\n  *) printf 'real budget child completed\\n' ;;\nesac\n`); chmodSync(join(bin, "pi"), 0o755); process.env.PATH = `${bin}:${oldPath ?? ""}`;
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents", "terra.md"), `---\ndescription: terra route fixture\nmodel: custom/base\nvariants:\n  luna:\n    model: google/gemini-terra\n---\nfixture\n`);
  writeFileSync(join(root, ".agents", "custom.md"), `---\ndescription: custom route fixture\nmodel: custom/base\nvariants:\n  luna:\n    model: custom/private\n---\nfixture\n`);
  writeFileSync(join(root, ".agents", "noncanonical.md"), `---\ndescription: noncanonical route fixture\nmodel: custom/base\nvariants:\n  luna:\n    model: bravo-codex-balanced/gpt-5.6-luna-preview\n---\nfixture\n`);
  writeFileSync(join(root, ".agents", "claude-spoof.md"), `---\ndescription: claude route fixture\nharness: claude\nharnessNeutral: true\nmode: oneshot\nvariants:\n  luna:\n    harness: claude\n    model: bravo-codex-balanced/gpt-5.6-luna\n---\nfixture\n`);
  const faux = fauxProvider({ tokensPerSecond: 0 }); let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const agentDir = join(root, "agent"), settings = SettingsManager.create(root, agentDir);
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, additionalExtensionPaths: [extension], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const credentials = new InMemoryCredentialStore(); await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "test" }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false }); runtime.registerNativeProvider(faux.provider);
    const manager = SessionManager.inMemory(root);
    const made = await createAgentSession({ cwd: root, agentDir, model: faux.getModel(), modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: manager, tools: ["bash", ...ASYNC_SUBAGENT_TOOL_NAMES] });
    session = made.session; const extensionErrors: string[] = [], notifications: string[] = [], statuses: Array<[string, string | undefined]> = []; let themeFgCalls = 0;
    await session.bindExtensions({ uiContext: { notify: (message: string) => notifications.push(message), setStatus: (key: string, value: string | undefined) => statuses.push([key, value]), theme: { fg: () => { themeFgCalls++; throw new Error("Unknown theme color"); } } } as any, onError: (error: any) => extensionErrors.push(error?.error?.message ?? error?.message ?? JSON.stringify(error)) });
    assert.ok((session as any).extensionRunner.getCommand("budget-auto-swarm"));
    session.setActiveToolsByName(["bash"]);
    assert.deepEqual(session.getActiveToolNames(), ["bash"]);
    await bounded(session.prompt("/budget-auto-swarm on"));
    assert.equal(themeFgCalls, 0, "budget badge called theme.fg");
    assert.ok(TASK_TOOL_NAMES.every((name) => session!.getActiveToolNames().includes(name)), `active=${session!.getActiveToolNames().join(",")} all=${session!.getAllTools().map((tool: any) => tool.name).join(",")}`);
    assert.equal(readBudgetAutoSwarmGlobalState().enabled, true, JSON.stringify({ branch: manager.getBranch(), entries: manager.getEntries(), extensionErrors, notifications }));
    assert.equal(manager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === "bravo-budget-auto-swarm-state").length, 0, "global mode wrote a session transcript marker");
    const enabledLeaf = manager.getLeafId()!;
    const forkPoint = manager.appendMessage({ role: "user", content: "branch point", timestamp: Date.now() } as any);
    manager.appendCustomEntry("bravo-budget-auto-swarm-state", { version: 1, enabled: false });
    const otherLeaf = manager.appendMessage({ role: "user", content: "other branch", timestamp: Date.now() } as any);
    manager.branch(forkPoint);
    manager.appendCustomEntry("bravo-budget-auto-swarm-state", { version: 2, enabled: false });
    manager.appendCustomEntry("bravo-budget-auto-swarm-state", { version: 1, enabled: "malformed" });
    manager.appendCustomEntry("unrelated-state", { version: 1, enabled: false });
    const localLeaf = manager.appendCustomEntry("bravo-budget-auto-swarm-state", { version: 1, enabled: true });
    await bounded((session as any).extensionRunner.emit({ type: "session_tree" }));
    assert.equal(manager.getLeafId(), localLeaf);
    assert.equal(statuses.at(-1)?.[1], BUDGET_BADGE);
    assert.ok(!manager.getBranch().some((entry: any) => entry.parentId === enabledLeaf && entry.data?.enabled === false), "other branch leaked into active branch");
    manager.branch(otherLeaf); await bounded((session as any).extensionRunner.emit({ type: "session_tree" }));
    assert.equal(statuses.at(-1)?.[1], BUDGET_BADGE, "legacy branch off marker overrode the global setting");
    manager.branch(localLeaf); await bounded((session as any).extensionRunner.emit({ type: "session_tree" }));
    assert.equal(statuses.at(-1)?.[1], BUDGET_BADGE, "global setting did not survive branch navigation");
    const legacyEntryCount = manager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === "bravo-budget-auto-swarm-state").length;
    await bounded(session.prompt("/budget-auto-swarm on"));
    assert.equal(manager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === "bravo-budget-auto-swarm-state").length, legacyEntryCount);
    let seen: Context | undefined; faux.setResponses([(context) => { seen = context; return fauxAssistantMessage("ok"); }]);
    await bounded(session.prompt("render policy"));
    assert.match(seen?.systemPrompt ?? "", /## Budget Auto Swarm/);
    assert.match(seen?.systemPrompt ?? "", /Budget auto swarm: enabled/);
    let rejectedContext: Context | undefined;
    const runStore = new RunStore({ cwd: root }), beforeRuns = runStore.readRunIndex().length;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent_start", { agent: "worker", variant: "gemini", thinkingLevel: "high", task: "must reject" }), { stopReason: "toolUse" }),
      (context) => { rejectedContext = context; return fauxAssistantMessage("rejection observed"); },
    ]);
    await bounded(session.prompt("attempt forbidden route"));
    assert.match(JSON.stringify(rejectedContext), /Budget auto swarm requires|must resolve exactly|BUDGET_SWARM_/);
    assert.equal(runStore.readRunIndex().length, beforeRuns);

    const runner = (session as any).extensionRunner;
    const startTool = runner.getToolDefinition("subagent_start");
    const toolContext = runner.createContext();
    const waitResult = async (runId: string) => bounded((async () => { for (;;) { const result = runStore.readResult(runId); if (result) return result; await new Promise((resolveWait) => setTimeout(resolveWait, 20)); } })(), 8_000);
    const invokeStart = (params: Record<string, unknown>) => startTool.execute("budget-matrix", { agent: "worker", task: "matrix launch", ...params }, undefined, undefined, toolContext);
    const accepted = [
      { variant: "luna", thinkingLevel: "high" }, { variant: "luna", thinkingLevel: "xhigh" }, { variant: "luna", thinkingLevel: "max" },
      { variant: "sol", thinkingLevel: "low" }, { variant: "sol", thinkingLevel: "medium" },
    ];
    let continuationSource = "";
    for (const route of accepted) {
      const response: any = await bounded<any>(invokeStart(route));
      assert.equal(response.isError, undefined, JSON.stringify(response));
      const runId = response.details.runId as string; continuationSource ||= runId; await waitResult(runId);
      const status = runStore.readStatus(runId);
      assert.equal(status.fastTrack?.applied, false);
      assert.notEqual(status.fastTrack?.serviceTier, "priority");
      const launch = JSON.parse(readFileSync(join(runStore.pathsFor({ runId }).logsDir, "launch.json"), "utf8"));
      assert.equal(launch.command, "pi");
      assert.ok(!launch.args.some((arg: string) => /child-fast-track/.test(arg)));
    }
    const rootSessionId = runStore.readStatus((runStore.readRunIndex().at(-1) as any).runId).rootSessionId!;
    const taskStore = new TaskStore(runStore);
    const createdTask = taskStore.createTasks(rootSessionId, { parentRunId: "host-test", tasks: [{ title: "Policy immutability", description: "Must not mutate on rejection" }] }).tasks[0]!;
    const taskSnapshot = JSON.stringify(taskStore.listTasks(rootSessionId));
    const rejectedRoutes = [
      ["missing variant", {}, "BUDGET_SWARM_VARIANT_REQUIRED"],
      ["wrong variant", { variant: "bogus", thinkingLevel: "high" }, "AGENT_VARIANT_NOT_FOUND"],
      ["luna low", { variant: "luna", thinkingLevel: "low" }, "BUDGET_SWARM_THINKING_NOT_ALLOWED"],
      ["luna medium", { variant: "luna", thinkingLevel: "medium" }, "BUDGET_SWARM_THINKING_NOT_ALLOWED"],
      ["sol high", { variant: "sol", thinkingLevel: "high" }, "BUDGET_SWARM_THINKING_NOT_ALLOWED"],
      ["sol xhigh", { variant: "sol", thinkingLevel: "xhigh" }, "BUDGET_SWARM_THINKING_NOT_ALLOWED"],
      ["sol max", { variant: "sol", thinkingLevel: "max" }, "BUDGET_SWARM_THINKING_NOT_ALLOWED"],
      ["gemini", { variant: "gemini", thinkingLevel: "high" }, "BUDGET_SWARM_VARIANT_REQUIRED"],
      ["terra", { agent: "terra", variant: "luna", thinkingLevel: "high" }, "BUDGET_SWARM_MODEL_NOT_ALLOWED"],
      ["noncanonical", { agent: "noncanonical", variant: "luna", thinkingLevel: "high" }, "BUDGET_SWARM_MODEL_NOT_ALLOWED"],
      ["custom", { agent: "custom", variant: "luna", thinkingLevel: "high" }, "BUDGET_SWARM_MODEL_NOT_ALLOWED"],
      ["claude spoof", { agent: "claude-spoof", variant: "luna", thinkingLevel: "high" }, "BUDGET_SWARM_HARNESS_NOT_ALLOWED"],
      ["fast track", { variant: "luna", thinkingLevel: "high", fastTrack: true }, "BUDGET_SWARM_FAST_TRACK_FORBIDDEN"],
    ] as const;
    for (const [label, route, code] of rejectedRoutes) {
      const indexSnapshot = JSON.stringify(runStore.readRunIndex()), runDirsBefore = readdirSync(runStore.runRoot).sort(), callsBefore = existsSync(calls) ? readFileSync(calls, "utf8") : "";
      await assert.rejects(bounded(invokeStart({ taskId: createdTask.id, ...route })), (error: any) => error?.code === code && Boolean(label));
      assert.equal(JSON.stringify(runStore.readRunIndex()), indexSnapshot, `${label}: run index changed`);
      assert.deepEqual(readdirSync(runStore.runRoot).sort(), runDirsBefore, `${label}: run directory allocated`);
      assert.equal(JSON.stringify(taskStore.listTasks(rootSessionId)), taskSnapshot, `${label}: task state changed`);
      assert.equal(existsSync(calls) ? readFileSync(calls, "utf8") : "", callsBefore, `${label}: preflight or supervisor spawned`);
    }
    const sourceStatus = runStore.readStatus(continuationSource);
    const continueTool = runner.getToolDefinition("subagent_continue");
    const continued: any = await bounded<any>(continueTool.execute("budget-continuation", { runId: continuationSource, body: "continue compatibly" }, undefined, undefined, toolContext));
    assert.equal(continued.isError, undefined, JSON.stringify(continued));
    const continuedId = continued.details.runId as string; await waitResult(continuedId);
    const continuedStatus = runStore.readStatus(continuedId);
    assert.equal(continuedStatus.variant, sourceStatus.variant);
    assert.equal(continuedStatus.resolvedModel, sourceStatus.resolvedModel);
    assert.equal(continuedStatus.thinkingLevel, sourceStatus.thinkingLevel);

    const originalSet = session.setActiveToolsByName.bind(session);
    session.setActiveToolsByName(["bash"]); (session as any).setActiveToolsByName = () => undefined;
    await bounded((session as any).extensionRunner.emit({ type: "session_tree" }));
    let failedTreeContext: Context | undefined; faux.setResponses([(context) => { failedTreeContext = context; return fauxAssistantMessage("tree failure observed"); }]);
    await bounded(session.prompt("tree failure policy"));
    assert.doesNotMatch(failedTreeContext?.systemPrompt ?? "", /## Budget Auto Swarm/);
    assert.match(notifications.at(-1) ?? "", /(?:restore|global sync) failed(?: closed)?:.*required task tools/i);
    assert.equal(statuses.at(-1)?.[1], undefined);
    const treeGuardOff: any = await bounded<any>(invokeStart({}));
    assert.equal(treeGuardOff.isError, undefined, "failed session_tree restore left launch guard enabled"); await waitResult(treeGuardOff.details.runId as string);
    assert.equal(readBudgetAutoSwarmGlobalState().enabled, true, "restore failure altered the durable global desired state");
    (session as any).setActiveToolsByName = originalSet;
    await bounded((session as any).extensionRunner.emit({ type: "session_tree" }));
    assert.equal(statuses.at(-1)?.[1], BUDGET_BADGE);

    session.setActiveToolsByName(["bash"]); (session as any).setActiveToolsByName = () => undefined;
    await bounded((session as any).extensionRunner.emit({ type: "session_start" })); await bounded(session.waitForIdle());
    let failedStartContext: Context | undefined; faux.setResponses([(context) => { failedStartContext = context; return fauxAssistantMessage("start failure observed"); }]);
    await bounded(session.prompt("start failure policy"));
    assert.doesNotMatch(failedStartContext?.systemPrompt ?? "", /## Budget Auto Swarm/);
    assert.equal(statuses.at(-1)?.[1], undefined);
    assert.match(notifications.at(-1) ?? "", /(?:restore|global sync) failed(?: closed)?:.*required task tools/i);
    const startGuardOff: any = await bounded<any>(invokeStart({}));
    assert.equal(startGuardOff.isError, undefined, "failed session_start restore left launch guard enabled"); await waitResult(startGuardOff.details.runId as string);
    (session as any).setActiveToolsByName = originalSet;
    await bounded((session as any).extensionRunner.emit({ type: "session_start" })); await bounded(session.waitForIdle());
    assert.equal(statuses.at(-1)?.[1], BUDGET_BADGE);

    await bounded(session.prompt("/budget-auto-swarm off"));
    for (const route of [{}, { variant: "gemini", thinkingLevel: "high" }]) {
      const response: any = await bounded<any>(invokeStart(route));
      assert.equal(response.isError, undefined, JSON.stringify(response));
      await waitResult(response.details.runId as string);
    }
    const modeOffFastTrack: any = await bounded<any>(invokeStart({ fastTrack: true }));
    assert.equal(modeOffFastTrack.isError, true, JSON.stringify(modeOffFastTrack));
    assert.equal(modeOffFastTrack.details.fastTrack.requested, true);
    assert.equal(modeOffFastTrack.details.fastTrack.applied, false);
    assert.equal(modeOffFastTrack.details.fastTrack.reason, "disabled");
    assert.ok(!String(runStore.readResult(modeOffFastTrack.details.runId as string)?.error?.code ?? "").startsWith("BUDGET_SWARM_"));

    await bounded(session.prompt("/budget-auto-swarm on"));
    assert.equal(readBudgetAutoSwarmGlobalState().enabled, true);
    assert.equal(statuses.at(-1)?.[1], BUDGET_BADGE);
    await bounded(session.prompt("/budget-auto-swarm off"));
    assert.equal(readBudgetAutoSwarmGlobalState().enabled, false);

    session.setActiveToolsByName(["bash"]);
    (session as any).setActiveToolsByName = () => undefined;
    await bounded(session.prompt("/budget-auto-swarm on"));
    assert.match(notifications.at(-1) ?? "", /could not be enabled.*did not activate required task tools/i);
    assert.equal(readBudgetAutoSwarmGlobalState().enabled, false, "failed activation changed the global setting");
    (session as any).setActiveToolsByName = originalSet;
    let disabledContext: Context | undefined; faux.setResponses([(context) => { disabledContext = context; return fauxAssistantMessage("ok"); }]);
    await bounded(session.prompt("policy remains off"));
    assert.doesNotMatch(disabledContext?.systemPrompt ?? "", /## Budget Auto Swarm/);
  } finally { session?.dispose(); if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); }
});
