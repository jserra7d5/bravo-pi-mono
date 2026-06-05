import type { ScannedFile, TransformChange } from "./types.js";

const GUIDANCE = "Use bash with run_in_background: true for long-running work whose process you own; do not append shell &. For background calls, timeout is the process max runtime, not a client wait timeout. Monitor via returned output paths or background_task_list/status/stop.";

export function proposeTransforms(file: ScannedFile): TransformChange[] {
  if (file.kind === "run-artifact" || file.kind === "cache") return [];
  const changes: TransformChange[] = [];
  const text = file.content;

  if (/shell\s*&|\bbash\b|background|tmux|watcher|server/i.test(text) && !text.includes("run_in_background")) {
    changes.push({ id: "prompt-background-guidance", description: "Add background bash usage guidance to prompt-like content.", risk: "low", oldText: text, newText: `${text.trimEnd()}\n\n${GUIDANCE}\n` });
  }

  if (/--exclude-tools(?:=|\s+)[^\n]*\bbash\b/.test(text)) {
    changes.push({ id: "warn-exclude-tools-bash", description: "Detected --exclude-tools bash; manual review is required so extension bash is not excluded.", risk: "high", oldText: text, newText: text });
  }
  if (/--no-builtin-tools/.test(text) && !/background_task_(list|status|stop)/.test(text)) {
    changes.push({ id: "no-builtin-tools-task-controls", description: "Add task control tool names near --no-builtin-tools guidance.", risk: "medium", oldText: text, newText: `${text.trimEnd()}\n# Background bash migration: ensure bash, background_task_list, background_task_status, and background_task_stop are explicitly enabled with this extension.\n` });
  }

  const jsonChanges = transformJsonToolLists(text);
  changes.push(...jsonChanges);
  return coalesce(changes);
}

function transformJsonToolLists(text: string): TransformChange[] {
  try {
    const data = JSON.parse(text) as unknown;
    let changed = false;
    let denyHasBash = false;
    const allowKeys = /^(tools|activeTools|allowedTools|allowTools|toolAllowlist|enabledTools)$/i;
    const denyKeys = /^(excludeTools|excludedTools|denyTools|deniedTools|toolDenylist|disabledTools)$/i;
    const addTaskTools = (v: unknown[]): void => { for (const t of ["background_task_list", "background_task_status", "background_task_stop"]) if (!v.includes(t)) { v.push(t); changed = true; } };
    const visit = (v: unknown, key?: string): void => {
      if (Array.isArray(v)) {
        if (v.includes("bash")) {
          if (key && allowKeys.test(key)) addTaskTools(v);
          else if (key && denyKeys.test(key)) denyHasBash = true;
        }
      } else if (v && typeof v === "object") {
        const obj = v as Record<string, unknown>;
        if (obj.extensions && Array.isArray(obj.extensions) && !obj.extensions.includes("@bravo/pi-extension-background-bash")) { obj.extensions.push("@bravo/pi-extension-background-bash"); changed = true; }
        for (const [childKey, child] of Object.entries(obj)) visit(child, childKey);
      }
    };
    visit(data);
    const out: TransformChange[] = [];
    if (changed) out.push({ id: "json-tool-config", description: "Ensure JSON allowlisted/active tool lists include background task controls and extension loading where detectable.", risk: "medium", oldText: text, newText: `${JSON.stringify(data, null, 2)}\n` });
    if (denyHasBash) out.push({ id: "warn-json-deny-bash", description: "Detected JSON deny/exclude tool list containing bash; manual review is required so extension bash is not excluded.", risk: "high", oldText: text, newText: text });
    return out;
  } catch { return []; }
}

function coalesce(changes: TransformChange[]): TransformChange[] {
  const real = changes.filter(c => c.oldText !== c.newText);
  const warnings = changes.filter(c => c.oldText === c.newText);
  if (real.length <= 1) return [...real, ...warnings];
  const last = real[real.length - 1]!;
  return [{ ...last, id: real.map(c => c.id).join("+"), description: real.map(c => c.description).join(" ") }, ...warnings];
}

export function applyChanges(content: string, changes: TransformChange[]): string {
  let next = content;
  for (const change of changes) if (change.oldText !== change.newText) next = next.replace(change.oldText, change.newText);
  return next;
}
