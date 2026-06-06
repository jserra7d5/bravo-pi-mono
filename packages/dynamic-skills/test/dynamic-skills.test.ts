import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/pi/index.js";
import { discoverDynamicSkillCandidates, isContained } from "../src/scanner.js";
import { appendDynamicSkillPrompt, renderCatalog } from "../src/render.js";
import { DynamicSkillState, latestSnapshotFromBranch } from "../src/state.js";

async function repo() { return mkdtemp(join(tmpdir(), "dyn-skills-")); }
async function skill(root: string, name: string, desc = "desc", extra = "", body = "BODY") {
  const dir = join(root, ".agents", "skills", name); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n${body}\n`);
  return join(dir, "SKILL.md");
}

test("path.relative containment rejects sibling-prefix escapes", () => {
  assert.equal(isContained("/repo", "/repo/sub"), true);
  assert.equal(isContained("/repo", "/repo-other"), false);
  assert.equal(isContained("/repo/sub", "/repo/submarine"), false);
});

test("scanner discovers upward eligible skills and excludes disabled/missing description/siblings", async () => {
  const cwd = await repo();
  await mkdir(join(cwd, "sub", "deep"), { recursive: true });
  await writeFile(join(cwd, "sub", "deep", "file.txt"), "x");
  const loc = await skill(join(cwd, "sub"), "good", "hello <world>");
  await skill(cwd, "off", "no", "disable-model-invocation: true\n");
  await skill(join(cwd, "sibling"), "sib", "no");
  const { candidates } = await discoverDynamicSkillCandidates(cwd, "sub/deep/file.txt");
  assert.deepEqual(candidates.map((s) => s.name).sort(), ["good"]);
  assert.equal(candidates[0].location, loc);
});

test("scanner rejects symlinked .agents directory", async () => {
  const cwd = await repo(); const outside = await repo();
  await mkdir(join(cwd, "sub"), { recursive: true }); await writeFile(join(cwd, "sub", "f"), "x");
  await mkdir(join(outside, ".agents", "skills"), { recursive: true });
  await symlink(join(outside, ".agents"), join(cwd, ".agents"));
  const result = await discoverDynamicSkillCandidates(cwd, "sub/f");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.some((d) => d.type === "security-boundary"), true);
});

test("scanner rejects symlinked skill directories", async () => {
  const cwd = await repo(); const outside = await repo();
  await mkdir(join(cwd, "sub"), { recursive: true }); await writeFile(join(cwd, "sub", "f"), "x");
  await mkdir(join(cwd, ".agents", "skills"), { recursive: true });
  await mkdir(join(outside, "skill"), { recursive: true }); await writeFile(join(outside, "skill", "SKILL.md"), "---\nname: x\ndescription: x\n---\n");
  await symlink(join(outside, "skill"), join(cwd, ".agents", "skills", "x"));
  const result = await discoverDynamicSkillCandidates(cwd, "sub/f");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.some((d) => d.type === "security-boundary"), true);
});

test("scanner rejects symlinked SKILL.md", async () => {
  const cwd = await repo(); const outside = await repo();
  await mkdir(join(cwd, "sub"), { recursive: true }); await writeFile(join(cwd, "sub", "f"), "x");
  await mkdir(join(cwd, ".agents", "skills", "x"), { recursive: true });
  await writeFile(join(outside, "SKILL.md"), "---\nname: x\ndescription: x\n---\n");
  await symlink(join(outside, "SKILL.md"), join(cwd, ".agents", "skills", "x", "SKILL.md"));
  const result = await discoverDynamicSkillCandidates(cwd, "sub/f");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.some((d) => d.type === "security-boundary"), true);
});

test("state collision policy keeps first dynamic and native wins", async () => {
  const st = new DynamicSkillState();
  const a = { name: "same", description: "a", location: "/tmp/a/SKILL.md", baseDir: "/tmp/a", discoveredFrom: "/tmp/f", discoveredAt: new Date().toISOString() };
  const b = { ...a, location: "/tmp/b/SKILL.md", baseDir: "/tmp/b" };
  assert.equal(st.acceptCandidates([a]).length, 1);
  assert.equal(st.acceptCandidates([b]).length, 0);
  assert.equal(st.diagnostics.at(-1)?.type, "dynamic-name-collision");
  const st2 = new DynamicSkillState();
  assert.equal(st2.acceptCandidates([a], [{ name: "same", filePath: "/tmp/native/SKILL.md" }]).length, 0);
  assert.equal(st2.diagnostics.at(-1)?.type, "native-name-collision");
});

test("render is bounded, escaped, idempotent, and body-free", () => {
  const s = { name: "a<&", description: "d>".repeat(400), location: "/x", baseDir: "/", discoveredFrom: "/f", discoveredAt: "t" };
  const xml = renderCatalog([s]);
  assert.match(xml, /a&lt;&amp;/); assert.doesNotMatch(xml, /BODY/); assert.ok((xml.match(/d&gt;/g) ?? []).length <= 251);
  const once = appendDynamicSkillPrompt("base", [s]);
  const twice = appendDynamicSkillPrompt(once, [s]);
  assert.equal((twice.match(/Dynamically discovered/g) ?? []).length, 1);
});

test("extension patches read content with discovery preview when native skills are known", async () => {
  const cwd = await repo(); await mkdir(join(cwd, "sub"), { recursive: true }); await writeFile(join(cwd, "sub", "f"), "x"); await skill(join(cwd, "sub"), "dyn", "desc");
  const handlers = new Map<string, Function>(); const entries: unknown[] = [];
  const pi = { on: (n: string, h: Function) => handlers.set(n, h), appendEntry: (t: string, p: unknown) => entries.push({ type: t, value: p }) };
  await extension(pi as never);
  const out = await handlers.get("tool_result")!({ toolName: "read", input: { path: "sub/f" }, content: "file", systemPromptOptions: { skills: [] } }, { cwd });
  assert.match(out.content, /^file\n\nDiscovered 1 additional repo skills/);
  assert.match(out.content, /<name>dyn<\/name>/);
  assert.deepEqual((entries.at(-1) as { value?: { skills?: { name: string }[] } }).value?.skills?.map((s) => s.name), ["dyn"]);
});

test("extension preserves structured read content when appending discovery preview", async () => {
  const cwd = await repo(); await mkdir(join(cwd, "sub"), { recursive: true }); await writeFile(join(cwd, "sub", "f"), "x"); await skill(join(cwd, "sub"), "dyn", "desc");
  const handlers = new Map<string, Function>();
  await extension({ on: (n: string, h: Function) => handlers.set(n, h), appendEntry: () => {} } as never);
  const objectContent = { type: "image", data: "opaque" };
  const out = await handlers.get("tool_result")!({ toolName: "read", input: { path: "sub/f" }, content: objectContent, systemPromptOptions: { skills: [] } }, { cwd });
  assert.deepEqual(out.content[0], objectContent);
  assert.match(out.content[1].text, /Discovered 1 additional repo skills/);
});

test("extension preserves explicit null read content when appending discovery preview", async () => {
  const cwd = await repo(); await mkdir(join(cwd, "sub"), { recursive: true }); await writeFile(join(cwd, "sub", "f"), "x"); await skill(join(cwd, "sub"), "dyn", "desc");
  const handlers = new Map<string, Function>();
  await extension({ on: (n: string, h: Function) => handlers.set(n, h), appendEntry: () => {} } as never);
  const out = await handlers.get("tool_result")!({ toolName: "read", input: { path: "sub/f" }, content: null, systemPromptOptions: { skills: [] } }, { cwd });
  assert.equal(out.content[0], null);
  assert.match(out.content[1].text, /Discovered 1 additional repo skills/);
});

test("extension handles absent read content with preview-only content", async () => {
  const cwd = await repo(); await mkdir(join(cwd, "sub"), { recursive: true }); await writeFile(join(cwd, "sub", "f"), "x"); await skill(join(cwd, "sub"), "dyn", "desc");
  const handlers = new Map<string, Function>();
  await extension({ on: (n: string, h: Function) => handlers.set(n, h), appendEntry: () => {} } as never);
  const out = await handlers.get("tool_result")!({ toolName: "read", input: { path: "sub/f" }, systemPromptOptions: { skills: [] } }, { cwd });
  assert.equal(out.content.length, 1);
  assert.match(out.content[0].text, /Discovered 1 additional repo skills/);
});

test("extension stores pending tool_result candidates and reveals them in future prompt", async () => {
  const cwd = await repo(); await mkdir(join(cwd, "sub"), { recursive: true }); await writeFile(join(cwd, "sub", "f"), "x"); await skill(join(cwd, "sub"), "dyn", "desc");
  const handlers = new Map<string, Function>(); const entries: unknown[] = [];
  const pi = { on: (n: string, h: Function) => handlers.set(n, h), appendEntry: (t: string, p: unknown) => entries.push({ type: t, value: p }) };
  await extension(pi as never);
  const out = await handlers.get("tool_result")!({ toolName: "read", input: { path: "sub/f" }, content: "file" }, { cwd });
  assert.equal(out, undefined);
  assert.equal((entries.at(-1) as { value?: { pending?: unknown[] } }).value?.pending?.length, 1);
  const prompt = await handlers.get("before_agent_start")!({ systemPrompt: "base", systemPromptOptions: { skills: [] } }, { cwd });
  assert.match(prompt.systemPrompt, /dyn/);
  await handlers.get("session_compact")!({}, { cwd });
  assert.ok(entries.length >= 2);
});

test("acceptPending makes rejected collisions terminal and persists collision-only snapshots", async () => {
  const cwd = await repo(); await mkdir(join(cwd, "sub"), { recursive: true }); await writeFile(join(cwd, "sub", "f"), "x");
  const loc = await skill(join(cwd, "sub"), "dyn", "desc");
  const handlers = new Map<string, Function>(); const entries: unknown[] = [];
  const pi = { on: (n: string, h: Function) => handlers.set(n, h), appendEntry: (t: string, p: unknown) => entries.push({ type: t, value: p }) };
  await extension(pi as never);
  await handlers.get("tool_result")!({ toolName: "read", input: { path: "sub/f" }, content: "file" }, { cwd });
  assert.equal((entries.at(-1) as { value?: { pending?: unknown[] } }).value?.pending?.length, 1);
  const prompt = await handlers.get("before_agent_start")!({ systemPrompt: "base", systemPromptOptions: { skills: [{ name: "dyn", filePath: join(cwd, "native", "SKILL.md") }] } }, { cwd });
  assert.equal(prompt, undefined);
  const snap = (entries.at(-1) as { value?: { pending?: unknown[]; diagnostics?: { type: string }[] } }).value;
  assert.equal(snap?.pending?.length, 0);
  assert.equal(snap?.diagnostics?.at(-1)?.type, "native-name-collision");
  const diagCount = snap?.diagnostics?.length;
  await handlers.get("before_agent_start")!({ systemPrompt: "base", systemPromptOptions: { skills: [{ name: "dyn", filePath: join(cwd, "native", "SKILL.md") }] } }, { cwd });
  assert.equal((entries.at(-1) as { value?: { diagnostics?: unknown[] } }).value?.diagnostics?.length, diagCount);

  const st = new DynamicSkillState();
  const a = { name: "same", description: "a", location: loc, baseDir: join(cwd, "sub"), discoveredFrom: join(cwd, "sub", "f"), discoveredAt: new Date().toISOString() };
  const b = { ...a, location: join(cwd, "other", "SKILL.md"), baseDir: join(cwd, "other") };
  assert.equal(st.acceptCandidates([a]).length, 1);
  st.storePending([b]);
  assert.equal(st.acceptPending([]).length, 0);
  assert.equal(st.pending().length, 0);
  assert.equal(st.diagnostics.at(-1)?.type, "dynamic-name-collision");
});

test("extension instances keep isolated dynamic skill state", async () => {
  const cwd = await repo(); await mkdir(join(cwd, "sub"), { recursive: true }); await writeFile(join(cwd, "sub", "f"), "x"); await skill(join(cwd, "sub"), "dyn", "desc");
  const handlers1 = new Map<string, Function>(); const handlers2 = new Map<string, Function>();
  await extension({ on: (n: string, h: Function) => handlers1.set(n, h), appendEntry: () => {} } as never);
  await extension({ on: (n: string, h: Function) => handlers2.set(n, h), appendEntry: () => {} } as never);
  await handlers1.get("tool_result")!({ toolName: "read", input: { path: "sub/f" }, content: "file" }, { cwd });
  const prompt1 = await handlers1.get("before_agent_start")!({ systemPrompt: "base", systemPromptOptions: { skills: [] } }, { cwd });
  const prompt2 = await handlers2.get("before_agent_start")!({ systemPrompt: "base", systemPromptOptions: { skills: [] } }, { cwd });
  assert.match(prompt1.systemPrompt, /dyn/);
  assert.equal(prompt2, undefined);
});

test("malformed snapshot entries are ignored without throwing", () => {
  const st = new DynamicSkillState();
  assert.doesNotThrow(() => st.load({ version: 1, skills: [{ name: "bad" }, null], pending: [{ name: "also-bad", location: 1 }, { name: "ok", description: "d", location: "/tmp/ok/SKILL.md", baseDir: "/tmp/ok", discoveredFrom: "/tmp/f", discoveredAt: "t" }], diagnostics: [] }));
  assert.equal(st.skills().length, 0);
  assert.equal(st.pending().length, 1);
  assert.equal(st.pending()[0].name, "ok");
  assert.equal(st.diagnostics.filter((d) => d.type === "invalid-skill").length, 3);
});

test("rehydrates latest custom branch snapshot in branch order", () => {
  const first = { version: 1, skills: [{ name: "old" }] };
  const latest = { version: 1, skills: [{ name: "new" }] };
  assert.deepEqual(latestSnapshotFromBranch([
    { type: "custom", customType: "dynamic-skill-discovery", data: first },
    { type: "x" },
    { type: "custom", customType: "dynamic-skill-discovery", data: latest },
  ]), latest);
});
