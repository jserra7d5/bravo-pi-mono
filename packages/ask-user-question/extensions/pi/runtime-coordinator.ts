import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AskUserQuestionComponent } from "./component.js";
import { badge, QuestionInboxComponent } from "./inbox.js";
import { envelope, QuestionService, requestIdFor } from "./question-service.js";
import type { AskInput, PickerOutcome, QuestionEvent, QuestionRequest, RequestEnvelope } from "./schema.js";

export class RuntimeCoordinator {
  readonly service = new QuestionService();
  private waiters = new Map<string, { promise: Promise<RequestEnvelope>; resolve: (value: RequestEnvelope) => void }>();
  private lastStatus: string | undefined;
  private ctx?: ExtensionContext;
  constructor(private readonly pi: ExtensionAPI) {}

  private append(event: QuestionEvent): void {
    this.pi.appendEntry("async-user-question", event); // durable first, then apply
    this.service.apply(event);
    this.refresh();
  }
  private refresh(): void {
    if (!this.ctx) return;
    const value = badge(this.service.all());
    const color = value.urgency === "low" ? "dim" : value.urgency === "normal" ? "warning" : "error";
    const styled = value.text ? this.ctx.ui.theme.fg(color, value.text) : undefined;
    if (styled === this.lastStatus) return;
    this.lastStatus = styled;
    this.ctx.ui.setStatus("user-questions", styled);
  }
  rebuild(ctx: ExtensionContext): void {
    this.ctx = ctx; this.waiters.clear(); this.lastStatus = undefined;
    const events = ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === "async-user-question" ? [entry.data] : []);
    this.service.project(events); this.refresh();
    for (const request of this.service.all()) if (request.state !== "pending" && !request.answerDelivered) this.deliver(request);
  }
  shutdown(): void { this.waiters.clear(); }

  async ask(toolCallId: string, input: AskInput, ctx: ExtensionContext): Promise<RequestEnvelope> {
    this.ctx = ctx;
    const event = this.service.create(toolCallId, input); if (event) this.append(event);
    const request = this.service.get(event?.requestId ?? requestIdFor(toolCallId));
    if (!request) throw new Error("Question request could not be created");
    if (request.state !== "pending" || request.delivery === "non_blocking") return envelope(request);
    const alreadyWaiting = this.waiters.has(request.requestId); const waiting = this.wait(request.requestId); if (!alreadyWaiting) this.openPicker(request, ctx, () => this.cancelBlocking(request.requestId), "cancel"); return waiting;
  }
  async waitFor(id: string, ctx: ExtensionContext): Promise<RequestEnvelope> {
    this.ctx = ctx; let request = this.service.get(id); if (!request) throw new Error(`Unknown question request: ${id}`);
    if (request.state !== "pending") return envelope(request);
    const event = this.service.escalate(id); if (event) this.append(event);
    request = this.service.get(id)!; const alreadyWaiting = this.waiters.has(id); const waiting = this.wait(id); if (!alreadyWaiting) this.openPicker(request, ctx, () => this.cancelBlocking(id), "cancel"); return waiting;
  }
  withdraw(id: string, reason?: string): RequestEnvelope {
    const request = this.service.get(id); if (!request) throw new Error(`Unknown question request: ${id}`);
    const event = this.service.withdraw(id, reason); if (event) this.append(event);
    const current = this.service.get(id)!; if (event) this.resolveOrDeliver(current); return envelope(current);
  }
  private wait(id: string): Promise<RequestEnvelope> {
    const existing = this.waiters.get(id); if (existing) return existing.promise;
    let resolve!: (value: RequestEnvelope) => void; const promise = new Promise<RequestEnvelope>((r) => { resolve = r; });
    this.waiters.set(id, { promise, resolve }); return promise;
  }
  private openPicker(request: QuestionRequest, ctx: ExtensionContext, onClosed?: () => void, escapeLabel: "close" | "cancel" = "close"): void {
    void ctx.ui.custom<PickerOutcome>((tui, theme, _kb, done) => new AskUserQuestionComponent(request.questions, tui, theme, done, escapeLabel)).then((outcome) => {
      if (outcome.kind === "closed") { onClosed?.(); return; }
      const event = outcome.kind === "submitted" ? this.service.answer(request.requestId, outcome.answers) : this.service.decline(request.requestId);
      if (!event) return; this.append(event); this.resolveOrDeliver(this.service.get(request.requestId)!);
    });
  }
  private cancelBlocking(id: string): void {
    const event = this.service.withdraw(id, "Closed by user");
    if (event) this.append(event);
    const request = this.service.get(id);
    if (request && request.state !== "pending") this.resolveOrDeliver(request);
  }
  private resolveOrDeliver(request: QuestionRequest): void {
    const waiter = this.waiters.get(request.requestId);
    if (waiter) {
      // A live waiter is a delivery transport too. Persist its consumption before
      // resolving so replay can never reinterpret this answer as undelivered.
      const marker = this.service.delivered(request.requestId);
      if (marker) this.append(marker);
      this.waiters.delete(request.requestId);
      waiter.resolve(envelope(request));
      return;
    }
    this.deliver(request);
  }
  private deliver(request: QuestionRequest): void {
    if (request.answerDelivered || request.state === "pending" || request.state === "withdrawn") return;
    const details = envelope(request);
    try {
      this.pi.sendMessage({ customType: "async-user-question-answer", content: request.resolution?.kind === "answered" ? request.resolution.answers.map((a) => `${a.question}: ${[...a.selected_labels, ...(a.free_text ? [a.free_text] : [])].join(", ")}`).join("\n") : `Question request ${request.state}`, display: true, details: { ...details, terminal_event_id: request.terminalEventId } }, { deliverAs: "followUp", triggerTurn: true });
      // Accepted enqueue is the only Pi boundary. The crash gap before this marker may replay once.
      const marker = this.service.delivered(request.requestId); if (marker) this.append(marker);
    } catch (error) { this.ctx?.ui.notify(`Could not deliver question answer: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  }
  openInbox(ctx: ExtensionContext): void {
    this.ctx = ctx; const pending = this.service.pending();
    if (!ctx.hasUI) { ctx.ui.notify("Question inbox requires an interactive session", "error"); return; }
    if (!pending.length) { ctx.ui.notify("No pending user questions", "info"); return; }
    void ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => new QuestionInboxComponent(pending, theme, done, () => tui.requestRender()), {
      overlay: true,
      overlayOptions: { anchor: "bottom-center", width: "80%", maxHeight: "70%", margin: { right: 2, bottom: 3, left: 2 } },
    }).then((id) => { const request = id && this.service.get(id); if (request) this.openPicker(request, ctx, () => this.openInbox(ctx)); });
  }
}
