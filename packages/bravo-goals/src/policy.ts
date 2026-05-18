import { createHash } from "node:crypto";
import { access, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { ensureDir } from "./fs.js";

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

export interface GoalPolicy {
	schema_version: 1;
	goal_id: string;
	workspace_root: string;
	goal_path: string;
	policy_path: string;
	mode: "prep" | "worker" | "judge" | "read_only";
	fail_closed: boolean;
	read: { deny: string[] };
	mutate: { deny: string[]; allow_exceptions: string[] };
	delete: { default: "deny" | "allow"; allow: string[]; deny: string[] };
	bash: { mode: "denied" | "constrained" | "unsafe_raw"; allow_prefixes: string[]; deny_patterns: string[] };
}

export async function createDefaultGoalPolicy(options: {
	workspaceRoot: string;
	goalId: string;
	activeTaskId?: string | null;
	mode?: GoalPolicy["mode"];
}): Promise<GoalPolicy> {
	const workspaceRoot = resolve(options.workspaceRoot);
	const goalPath = join(workspaceRoot, ".bravo", "goals", options.goalId);
	const policyPath = join(workspaceRoot, ".bravo", "runtime", "policies", options.goalId, "policy.yaml");
	const activeTask = options.activeTaskId ?? "*";
	const policy: GoalPolicy = {
		schema_version: 1,
		goal_id: options.goalId,
		workspace_root: workspaceRoot,
		goal_path: goalPath,
		policy_path: policyPath,
		mode: options.mode ?? "worker",
		fail_closed: true,
		read: { deny: [] },
		mutate: {
			deny: [
				"${policy_path}",
				"${workspace_root}/.bravo/runtime/**",
				"${workspace_root}/.bravo/runs/**",
				"${goal_path}/state.yaml",
				"${goal_path}/judge/**",
				"${goal_path}/receipts/*-judge.md",
			],
			allow_exceptions: [
				"${goal_path}/resume.md",
				`${"${goal_path}"}/receipts/${activeTask}-worker.md`,
			],
		},
		delete: {
			default: "deny",
			allow: [],
			deny: [
				"${workspace_root}/.bravo/**",
				"${workspace_root}/.git/**",
			],
		},
		bash: {
			mode: "constrained",
			allow_prefixes: [
				"npm test",
				"npm run",
				"npm --prefix ",
				"node --check ",
				"git add",
				"git commit",
				"git diff",
				"git status",
				"git worktree add",
				"git worktree list",
				"rg ",
				"sed -n ",
				"ls",
				"pwd",
				"cat ",
				"find ",
				"date ",
			],
			deny_patterns: [
				"\\brm\\b",
				"\\bgit\\s+(checkout|reset|clean|rm|mv|merge|rebase)\\b",
				";",
				"\\r|\\n",
				"(^|[^|])\\|($|[^|])",
				"`",
				"\\$\\(",
				"(^|[^&])&($|[^&])",
				"(^|[\\s;&|()])(?:\\d+)?(?:>>?|<<?|<<<|<>|>&|<&)",
				"(^|[\\s;&|()])(tee|xargs)\\b",
				"\\b(mkdir|touch|chmod|chown|cp|mv|python|python3|perl|ruby|sh|bash|zsh|curl|wget)\\b",
			],
		},
	};
	await writeGoalPolicy(policyPath, policy);
	return policy;
}

export async function writeGoalPolicy(path: string, policy: GoalPolicy): Promise<void> {
	await ensureDir(dirname(path));
	await writeFile(path, YAML.stringify(policy, { lineWidth: 0 }), "utf8");
}

export async function readGoalPolicy(path: string): Promise<GoalPolicy> {
	const raw = await readFile(path, "utf8");
	const parsed = YAML.parse(raw) as unknown;
	if (!isRecord(parsed) || parsed.schema_version !== 1) {
		throw new Error(`Invalid Bravo goal policy: ${path}`);
	}
	return parsed as unknown as GoalPolicy;
}

export async function sha256File(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function summarizeGoalPolicy(policy: GoalPolicy): string {
	return [
		"Bravo Goals policy is active.",
		`Policy path: ${policy.policy_path}`,
		`Mode: ${policy.mode}`,
		"Reads are broadly allowed unless the policy deny-list matches.",
		"Writes/edits are allowed for normal workspace files plus resume.md and the active worker receipt.",
		"Writes/edits are blocked for Bravo runtime, Judge runs, state.yaml, policy files, non-active receipts, and Judge receipts.",
		"Deletes are denied unless explicitly allowed.",
		`Bash mode: ${policy.bash.mode}.`,
	].join("\n");
}

export async function decidePath(policy: GoalPolicy, operation: "read" | "mutate" | "delete", inputPath: string): Promise<PolicyDecision> {
	const resolved = await resolvePolicyPath(policy.workspace_root, inputPath);
	if (!isInside(resolve(policy.workspace_root), resolved)) {
		return { allowed: false, reason: `${operation} outside workspace is blocked: ${inputPath}` };
	}
	const variables = policyVariables(policy);
	const deny = operation === "read" ? policy.read.deny : operation === "mutate" ? policy.mutate.deny : policy.delete.deny;
	const exceptions = operation === "mutate" ? policy.mutate.allow_exceptions : operation === "delete" ? policy.delete.allow : [];
	if (matchesAny(resolved, exceptions.map((pattern) => expandPattern(pattern, variables)))) {
		return { allowed: true };
	}
	if (matchesAny(resolved, deny.map((pattern) => expandPattern(pattern, variables)))) {
		return { allowed: false, reason: `${operation} blocked by Bravo policy: ${inputPath}` };
	}
	if (operation === "delete" && policy.delete.default === "deny") {
		return { allowed: false, reason: `delete blocked by Bravo policy: ${inputPath}` };
	}
	return { allowed: true };
}

export function decideBash(policy: GoalPolicy, command: string): PolicyDecision {
	if (policy.bash.mode === "unsafe_raw") return { allowed: true };
	if (policy.bash.mode === "denied") return { allowed: false, reason: "bash is blocked by Bravo policy" };
	for (const pattern of policy.bash.deny_patterns) {
		const regex = new RegExp(pattern);
		if (regex.test(command)) {
			return { allowed: false, reason: `bash command blocked by Bravo policy: ${command}` };
		}
	}
	const segments = bashCommandSegmentsForPolicy(command);
	if (segments.length === 0) {
		return { allowed: false, reason: `bash command is not policy-approved: ${command}` };
	}
	for (const segment of segments) {
		const decision = decideBashSegment(segment);
		if (!decision.allowed) return { allowed: false, reason: `${decision.reason}: ${command}` };
	}
	return { allowed: true };
}

function bashCommandSegmentsForPolicy(command: string): string[] {
	const normalized = command.trim();
	const cdMatch = /^cd\s+(?:"[^"]+"|'[^']+'|[^\s;&|()<>]+)\s+&&\s+([\s\S]+)$/.exec(normalized);
	if (cdMatch?.[1]) {
		return bashCommandSegmentsForPolicy(cdMatch[1]);
	}
	return normalized.split(/\s*(?:&&|\|\|)\s*/).map(normalizeBashCommandForPolicySegment).filter((segment) => segment.length > 0);
}

function normalizeBashCommandForPolicySegment(command: string): string {
	const normalized = command.trim();
	const gitCMatch = /^git\s+-C\s+(?:"[^"]+"|'[^']+'|[^\s;&|()<>]+)\s+([\s\S]+)$/.exec(normalized);
	if (gitCMatch?.[1]) {
		return `git ${gitCMatch[1].trim()}`;
	}
	return normalized;
}

function decideBashSegment(command: string): PolicyDecision {
	const [program, ...args] = tokenizeBashSegment(command);
	if (!program) return { allowed: false, reason: "empty bash segment" };
	if (READ_ONLY_COMMANDS.has(program)) return { allowed: true };
	if (program === "npm") return decideNpmSegment(args);
	if (program === "node") return args[0] === "--check" ? { allowed: true } : { allowed: false, reason: "node command is not policy-approved" };
	if (program === "git") return decideGitSegment(args);
	return { allowed: false, reason: `bash command is not policy-approved (${program})` };
}

function decideNpmSegment(args: string[]): PolicyDecision {
	const subcommand = args[0];
	if (subcommand === "test" || subcommand === "run") return { allowed: true };
	if (subcommand === "--prefix") return { allowed: true };
	return { allowed: false, reason: "npm command is not policy-approved" };
}

function decideGitSegment(args: string[]): PolicyDecision {
	const [subcommand, ...rest] = args;
	if (!subcommand) return { allowed: false, reason: "git command is missing subcommand" };
	if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return { allowed: true };
	if (subcommand === "worktree") {
		const worktreeSubcommand = rest[0];
		if (worktreeSubcommand === "list" || worktreeSubcommand === "add") return { allowed: true };
		return { allowed: false, reason: "git worktree command is not policy-approved" };
	}
	if (subcommand === "add" || subcommand === "commit") return { allowed: true };
	return { allowed: false, reason: `git command is not policy-approved (${subcommand})` };
}

function tokenizeBashSegment(command: string): string[] {
	const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	return matches.map((token) => {
		if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
			return token.slice(1, -1);
		}
		return token;
	});
}

const READ_ONLY_COMMANDS = new Set(["test", "[", "echo", "pwd", "ls", "find", "cat", "sed", "rg", "wc", "head", "tail", "date"]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "diff", "branch", "log", "show", "rev-parse", "remote", "describe", "ls-files"]);

async function resolvePolicyPath(workspaceRoot: string, inputPath: string): Promise<string> {
	const absolute = isAbsolute(inputPath) ? inputPath : resolve(workspaceRoot, inputPath);
	try {
		return await realpath(absolute);
	} catch {
		let current = dirname(absolute);
		for (;;) {
			try {
				const parent = await realpath(current);
				return join(parent, relative(current, absolute));
			} catch {
				const next = dirname(current);
				if (next === current) return absolute;
				current = next;
			}
		}
	}
}

function policyVariables(policy: GoalPolicy): Record<string, string> {
	return {
		workspace_root: resolve(policy.workspace_root),
		goal_path: resolve(policy.goal_path),
		policy_path: resolve(policy.policy_path),
	};
}

function expandPattern(pattern: string, variables: Record<string, string>): string {
	return pattern.replace(/\$\{([^}]+)\}/g, (_match, key: string) => variables[key] ?? "");
}

function matchesAny(path: string, patterns: string[]): boolean {
	return patterns.some((pattern) => globMatch(path, pattern));
}

function globMatch(path: string, pattern: string): boolean {
	const normalizedPath = path.split(sep).join("/");
	const normalizedPattern = pattern.split(sep).join("/");
	const regex = new RegExp(`^${globToRegex(normalizedPattern)}$`);
	return regex.test(normalizedPath);
}

function globToRegex(value: string): string {
	let out = "";
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index]!;
		if (char === "*") {
			if (value[index + 1] === "*") {
				out += ".*";
				index += 1;
			} else {
				out += "[^/]*";
			}
		} else {
			out += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return out;
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
