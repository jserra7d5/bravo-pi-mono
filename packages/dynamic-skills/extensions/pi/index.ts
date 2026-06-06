import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverDynamicSkillCandidates } from "../../src/scanner.js";
import { DynamicSkillState, latestSnapshotFromBranch, ENTRY_TYPE } from "../../src/state.js";
import { appendDynamicSkillPrompt, renderDiscoveryPreview } from "../../src/render.js";
import type { NativeSkill } from "../../src/types.js";

type AnyEvent = Record<string, unknown>;
type AnyCtx = Record<string, unknown>;

function cwdOf(event: AnyEvent, ctx: AnyCtx): string {
  return typeof ctx.cwd === "string" ? ctx.cwd : typeof event.cwd === "string" ? event.cwd : process.cwd();
}
function nativeSkills(event: AnyEvent): NativeSkill[] | undefined {
  const skills = (event.systemPromptOptions as { skills?: unknown } | undefined)?.skills;
  return Array.isArray(skills) ? skills as NativeSkill[] : undefined;
}
function patchContent(content: unknown, addition: string, hasOriginalContent = true): unknown {
  const previewPart = { type: "text", text: addition };
  if (typeof content === "string") return `${content.trimEnd()}\n\n${addition}`;
  if (Array.isArray(content)) return [...content, previewPart];
  if (!hasOriginalContent) return [previewPart];
  return [content, previewPart];
}
export default async function dynamicSkillsExtension(pi: ExtensionAPI): Promise<void> {
  const state = new DynamicSkillState();
  async function rehydrateLocal(ctx: AnyCtx) {
    const sm = ctx.sessionManager as { getBranch?: () => unknown | Promise<unknown> } | undefined;
    const branch = sm?.getBranch ? await sm.getBranch() : undefined;
    state.load(latestSnapshotFromBranch(branch));
  }
  async function appendSnapshotLocal() {
    const appendEntry = (pi as unknown as { appendEntry?: (type: string, payload: unknown) => unknown | Promise<unknown> }).appendEntry;
    if (appendEntry) await appendEntry.call(pi, ENTRY_TYPE, state.snapshot());
  }

  pi.on("session_start", async (_event, ctx) => { await rehydrateLocal(ctx as unknown as AnyCtx); });
  pi.on("session_tree", async (_event, ctx) => { await rehydrateLocal(ctx as unknown as AnyCtx); });

  (pi.on as (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => void)("tool_result", async (event, ctx) => {
    const e = event as AnyEvent;
    if (e.toolName !== "read" || e.isError === true) return undefined;
    const inputPath = (e.input as { path?: unknown } | undefined)?.path;
    if (typeof inputPath !== "string") return undefined;
    const natives = nativeSkills(e);
    const beforeDiag = state.diagnostics.length;
    const { candidates, diagnostics } = await discoverDynamicSkillCandidates(cwdOf(e, ctx as unknown as AnyCtx), inputPath);
    for (const d of diagnostics) state.addDiagnostic(d);
    if (!natives) {
      state.storePending(candidates);
      if (candidates.length || state.diagnostics.length !== beforeDiag) await appendSnapshotLocal();
      return undefined;
    }
    const accepted = state.acceptCandidates(candidates, natives);
    if (accepted.length || state.diagnostics.length !== beforeDiag) await appendSnapshotLocal();
    if (accepted.length) return { content: patchContent(e.content, renderDiscoveryPreview(accepted), Object.prototype.hasOwnProperty.call(e, "content")) };
    return undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const e = event as unknown as AnyEvent;
    const prompt = typeof e.systemPrompt === "string" ? e.systemPrompt : "";
    const natives = nativeSkills(e);
    const beforeDiag = state.diagnostics.length;
    const accepted = state.acceptPending(natives);
    if (accepted.length || state.diagnostics.length !== beforeDiag) await appendSnapshotLocal();
    const eligible = state.eligibleAgainstNative(natives);
    if (!eligible.length) return undefined;
    return { systemPrompt: appendDynamicSkillPrompt(prompt, eligible) };
  });

  pi.on("session_compact", async () => { if (state.skills().length || state.pending().length || state.diagnostics.length) await appendSnapshotLocal(); });
}
