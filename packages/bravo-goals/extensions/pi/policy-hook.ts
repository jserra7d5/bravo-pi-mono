import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { decideBash, decidePath, readGoalPolicy, sha256File, summarizeGoalPolicy, type GoalPolicy, type PolicyDecision } from "../../src/policy.js";
import { readActiveGoalsIndex } from "../../src/runtime.js";
import { discoverWorkspaceRoot } from "../../src/workspace.js";

interface ToolCallLike {
	toolName: string;
	input: Record<string, unknown>;
}

export function registerGoalPolicyHooks(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const policy = await resolveEffectivePolicy(ctx);
		if (!policy) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n# Bravo Goal Policy\n\n${summarizeGoalPolicy(policy)}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const policy = await resolveEffectivePolicy(ctx);
		if (!policy) return undefined;
		const decision = await decideToolCall(policy, event as ToolCallLike);
		if (!decision.allowed) {
			await auditPolicyBlock(ctx, policy, event.toolName, decision.reason);
			ctx.ui?.notify?.(decision.reason, "warning");
			return { block: true, reason: decision.reason };
		}
		return undefined;
	});

	pi.on("user_bash", async (event, ctx) => {
		const policy = await resolveEffectivePolicy(ctx);
		if (!policy) return undefined;
		const decision = decideBash(policy, event.command);
		if (!decision.allowed) {
			await auditPolicyBlock(ctx, policy, "user_bash", decision.reason);
			ctx.ui?.notify?.(decision.reason, "warning");
			return {
				result: {
					output: decision.reason,
					exitCode: 126,
					cancelled: false,
					truncated: false,
				},
			};
		}
		return undefined;
	});
}

async function decideToolCall(policy: GoalPolicy, event: ToolCallLike): Promise<PolicyDecision> {
	if (event.toolName === "bash") {
		const command = typeof event.input.command === "string" ? event.input.command : "";
		return decideBash(policy, command);
	}
	if (event.toolName === "read" || event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
		const path = extractPath(event.input);
		return path ? decidePath(policy, "read", path) : { allowed: true };
	}
	if (event.toolName === "write" || event.toolName === "edit") {
		const path = extractPath(event.input);
		return path ? decidePath(policy, "mutate", path) : { allowed: false, reason: `${event.toolName} missing path under Bravo policy` };
	}
	if (event.toolName === "delete" || event.toolName === "remove") {
		const path = extractPath(event.input);
		return path ? decidePath(policy, "delete", path) : { allowed: false, reason: `${event.toolName} missing path under Bravo policy` };
	}
	return { allowed: true };
}

function extractPath(input: Record<string, unknown>): string | null {
	for (const key of ["path", "file_path", "filePath"]) {
		const value = input[key];
		if (typeof value === "string") return value;
	}
	return null;
}

async function resolveEffectivePolicy(ctx: ExtensionContext): Promise<GoalPolicy | null> {
	const envPath = process.env.BRAVO_GOAL_POLICY_PATH;
	if (envPath) {
		const policy = await readGoalPolicy(envPath);
		const expectedHash = process.env.BRAVO_GOAL_POLICY_SHA256;
		if (expectedHash && await sha256File(envPath) !== expectedHash) {
			throw new Error("Bravo goal policy hash mismatch.");
		}
		return applyDefaultBashScoping(policy);
	}
	const workspaceRoot = await discoverWorkspaceRoot(ctx.cwd);
	if (!workspaceRoot) return null;
	const sessionId = ctx.sessionManager.getSessionId?.();
	if (!sessionId) return null;
	const index = await readActiveGoalsIndex(workspaceRoot);
	const active = index.active_goals.find((entry) => entry.pi_session_id === sessionId);
	if (!active) return null;
	return applyDefaultBashScoping(await readGoalPolicy(join(workspaceRoot, ".bravo", "runtime", "policies", active.goal_id, "policy.yaml")));
}

export function applyDefaultBashScoping(policy: GoalPolicy): GoalPolicy {
	if (policy.bash.mode !== "constrained" || process.env.BRAVO_GOALS_ENABLE_BASH_SCOPING === "1") return policy;
	return {
		...policy,
		bash: { ...policy.bash, mode: "unsafe_raw" },
	};
}

async function auditPolicyBlock(ctx: ExtensionContext, policy: GoalPolicy, toolName: string, reason: string): Promise<void> {
	await appendFile(join(policy.workspace_root, ".bravo", "logs", "policy-events.jsonl"), `${JSON.stringify({
		type: "policy.block",
		goal_id: policy.goal_id,
		session_id: ctx.sessionManager.getSessionId?.() ?? null,
		tool: toolName,
		reason,
		at: new Date().toISOString(),
	})}\n`);
}
