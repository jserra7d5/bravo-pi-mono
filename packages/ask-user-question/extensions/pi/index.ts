import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, TruncatedText, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { QUESTION_PROMPT } from "./prompt.js";
import { RuntimeCoordinator } from "./runtime-coordinator.js";
import { InputSchema, RequestIdInputSchema, type RequestEnvelope, WithdrawInputSchema } from "./schema.js";
import { validateUniqueness } from "./validate.js";

const NAMES = ["ask_user_question", "wait_for_user_question", "withdraw_user_question"];
const renderCall = (label: string) => (_args: unknown, theme: { fg(name: string, value: string): string; bold(value: string): string }) => new TruncatedText(theme.fg("toolTitle", theme.bold(label)), 0, 0);
class WrappedResult implements Component {
  constructor(private readonly text: string) {}
  invalidate(): void {}
  render(width: number): string[] {
    return this.text.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width))).map((line) => truncateToWidth(line, width));
  }
}
const renderResult = (value: { content: Array<{ type: string; text?: string }>; details?: RequestEnvelope }, _options: unknown, theme: { fg(name: string, value: string): string }) => {
  const text = theme.fg("text", value.content.find((item) => item.type === "text")?.text ?? "");
  return (value.details?.resolution?.answers.length ?? 0) > 1 ? new WrappedResult(text) : new TruncatedText(text, 0, 0);
};
function result(details: RequestEnvelope) {
  const resolution = details.resolution?.answers.map((a) => `${a.question}: ${[...a.selected_labels, ...(a.free_text ? [a.free_text] : [])].join(", ")}`).join("\n");
  return { content: [{ type: "text" as const, text: resolution ?? `Question ${details.request_id} is ${details.state} (${details.urgency}, ${details.delivery}).` }], details };
}
export default function (pi: ExtensionAPI) {
  const coordinator = new RuntimeCoordinator(pi);
  let enabled = true;
  const requireUI = (ctx: { hasUI: boolean }) => {
    if (ctx.hasUI) return true;
    enabled = false; pi.setActiveTools(pi.getActiveTools().filter((name) => !NAMES.includes(name))); return false;
  };
  pi.registerTool({
    name: "ask_user_question", label: "Ask User", description: "Create a durable structured user-question request. Use non_blocking when independent work can continue.", parameters: InputSchema,
    async execute(toolCallId, params, _signal, _update, ctx) {
      if (!requireUI(ctx)) return { content: [{ type: "text", text: "Error: user-question tools require an interactive session and are now disabled." }], details: undefined };
      if (!Value.Check(InputSchema, params)) return { content: [{ type: "text", text: "Error: invalid ask_user_question input" }], details: undefined };
      const error = validateUniqueness(params.questions); if (error) return { content: [{ type: "text", text: `Error: ${error}` }], details: undefined };
      return result(await coordinator.ask(toolCallId, params, ctx));
    },
    renderCall: renderCall("ask user"), renderResult,
  });
  pi.registerTool({
    name: "wait_for_user_question", label: "Wait for User Question", description: "Wait for an existing pending user-question request.", parameters: RequestIdInputSchema,
    async execute(_id, params, _signal, _update, ctx) { if (!requireUI(ctx)) return { content: [{ type: "text", text: "Error: user-question tools require an interactive session and are now disabled." }], details: undefined }; try { return result(await coordinator.waitFor(params.request_id, ctx)); } catch (e) { return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], details: undefined }; } },
    renderCall: renderCall("wait for user"), renderResult,
  });
  pi.registerTool({
    name: "withdraw_user_question", label: "Withdraw User Question", description: "Withdraw an obsolete pending user-question request.", parameters: WithdrawInputSchema,
    async execute(_id, params, _signal, _update, ctx) { if (!requireUI(ctx)) return { content: [{ type: "text", text: "Error: user-question tools require an interactive session and are now disabled." }], details: undefined }; try { return result(coordinator.withdraw(params.request_id, params.reason)); } catch (e) { return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], details: undefined }; } },
    renderCall: renderCall("withdraw user question"), renderResult,
  });
  const openQuestions = async (_args: string, ctx: ExtensionCommandContext) => coordinator.openInbox(ctx);
  pi.registerCommand("questions", { description: "Open pending user questions", handler: openQuestions });
  pi.registerCommand("q", { description: "Open pending user questions", handler: openQuestions });
  pi.registerShortcut(Key.ctrlShift("u"), { description: "Open pending user questions", handler: (ctx) => coordinator.openInbox(ctx) });
  pi.on("session_start", async (_event, ctx) => coordinator.rebuild(ctx));
  pi.on("session_shutdown", async () => coordinator.shutdown());
  pi.on("before_agent_start", async (event) => enabled && NAMES.every((name) => pi.getActiveTools().includes(name)) ? { systemPrompt: `${event.systemPrompt}\n\n${QUESTION_PROMPT}` } : undefined);
}
