import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapBravoSystemMessage } from "../../src/prompts.js";

export const BRAVO_GOAL_CONTROL_MESSAGE_TYPE = "bravo-goal-control";
export const BRAVO_GOAL_WATCHDOG_MESSAGE_TYPE = "bravo-goal-watchdog-recovery";
export const BRAVO_GOAL_FEDERAL_JUDGE_READY_MESSAGE_TYPE = "bravo-goal-federal-judge-ready";

export interface BravoControlMessageDetails {
	goal_id?: string;
	goal_title?: string;
	kind: string;
	next_action?: string;
}

export interface BravoMessageSender {
	sendMessage<T = unknown>(
		message: { customType: string; content: string; display: boolean; details?: T },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void | Promise<void>;
}

export function sendBravoControlMessage(
	pi: Pick<ExtensionAPI, "sendMessage">,
	prompt: string,
	details: BravoControlMessageDetails,
): void {
	pi.sendMessage({
		customType: BRAVO_GOAL_CONTROL_MESSAGE_TYPE,
		display: true,
		content: wrapBravoSystemMessage(prompt),
		details,
	}, { deliverAs: "followUp", triggerTurn: true });
}

export async function sendBravoControlMessageAsync(
	sender: BravoMessageSender,
	prompt: string,
	details: BravoControlMessageDetails,
): Promise<void> {
	await sender.sendMessage({
		customType: BRAVO_GOAL_CONTROL_MESSAGE_TYPE,
		display: true,
		content: wrapBravoSystemMessage(prompt),
		details,
	}, { deliverAs: "followUp", triggerTurn: true });
}
