import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { updateJudgeRunStatus, writeJudgeVerdict, type JudgeRunConfig, type JudgeVerdictFile } from "../../src/judge-runner.js";

const JudgeEventParams = Type.Object({
	goal_id: Type.String({ description: "Bravo goal id." }),
	event: Type.String({ description: "Judge event name such as task.receipt_ready or judge.completed." }),
	run_id: Type.Optional(Type.String({ description: "Judge run id, when known." })),
	receipt_path: Type.Optional(Type.String({ description: "Path to the relevant Judge or worker receipt." })),
	note: Type.Optional(Type.String({ description: "Short event note." })),
});

const JudgeFinishParams = Type.Object({
	goal_id: Type.String({ description: "Bravo goal id." }),
	run_id: Type.Optional(Type.String({ description: "Judge run id, when known." })),
	verdict: Type.Union([
		Type.Literal("pass"),
		Type.Literal("fail"),
		Type.Literal("needs_more_evidence"),
		Type.Literal("blocked"),
	]),
	receipt_path: Type.String({ description: "Path to the Judge receipt." }),
	summary: Type.Optional(Type.String({ description: "Short Judge result summary." })),
});

interface ToolContextLike {
	shutdown?: () => void;
}

export function registerJudgeControlTools(pi: ExtensionAPI): void {
	if (typeof pi.registerTool !== "function") return;

	pi.registerTool({
		name: "judge_event",
		label: "Judge event",
		description: "Record a Bravo Judge lifecycle event. This v1 Pi extension exposes the contract only.",
		parameters: JudgeEventParams,
		async execute(_toolCallId, params) {
			await appendJudgeControlEvent({
				type: params.event,
				goal_id: params.goal_id,
				run_id: params.run_id,
				receipt_path: params.receipt_path,
				note: params.note,
				at: new Date().toISOString(),
			});
			return {
				content: [
					{
						type: "text",
						text: `Judge event accepted: ${params.event} for ${params.goal_id}. Controller persistence is not wired in this slice.`,
					},
				],
				details: params,
			};
		},
	});

	pi.registerTool({
		name: "judge_finish",
		label: "Judge finish",
		description: "Signal completion of a Bravo Judge run with a verdict and receipt path. This v1 Pi extension exposes the contract only.",
		parameters: JudgeFinishParams,
		async execute(_toolCallId, params, _span, _toolCall, ctx?: ToolContextLike) {
			const runDir = process.env.BRAVO_JUDGE_RUN_DIR;
			if (!runDir) throw new Error("BRAVO_JUDGE_RUN_DIR is required for judge_finish persistence.");
			const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as JudgeRunConfig;
			const verdict: JudgeVerdictFile = {
				schema_version: 1,
				run_id: params.run_id ?? run.run_id,
				goal_id: params.goal_id,
				task_id: run.task_id,
				final_audit: run.final_audit,
				verdict: params.verdict,
				receipt_path: params.receipt_path,
				evidence_checked: [],
				commands_run: [],
				inspection_helpers: [],
				missing_or_weak_evidence: [],
				recommendation: params.verdict === "pass" ? "advance_task" : "return_to_worker",
				created_at: new Date().toISOString(),
			};
			await writeJudgeVerdict(runDir, verdict, renderJudgeReceipt(verdict, params.summary));
			await updateJudgeRunStatus(runDir, params.verdict === "blocked" ? "blocked" : params.verdict === "pass" ? "succeeded" : "failed");
			ctx?.shutdown?.();
			return {
				content: [
					{
						type: "text",
						text: `Judge finished for ${params.goal_id}: ${params.verdict}. Receipt: ${params.receipt_path}`,
					},
				],
				details: params,
			};
		},
	});
}

async function appendJudgeControlEvent(event: Record<string, unknown>): Promise<void> {
	const runDir = process.env.BRAVO_JUDGE_RUN_DIR;
	if (!runDir) return;
	await writeFile(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, { flag: "a" });
}

function renderJudgeReceipt(verdict: JudgeVerdictFile, summary?: string): string {
	return `---
schema_version: 1
type: judge
run_id: ${verdict.run_id}
task_id: ${verdict.task_id}
verdict: ${verdict.verdict}
created_at: "${verdict.created_at}"
verdict_path: ".bravo/runs/${verdict.run_id}/verdict.json"
receipt_path: "${verdict.receipt_path}"
commands: []
inspection_helpers: []
claims_checked: []
---

# Judge Receipt

${summary ?? "Judge finished through judge_finish."}
`;
}
