import { createHash } from "node:crypto";
import type { Answer, AskInput, NormalizedQuestion, QuestionEvent, QuestionRequest, RequestEnvelope } from "./schema.js";

const iso = () => new Date().toISOString();
const stableId = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
export const requestIdFor = (toolCallId: string) => stableId("uq", toolCallId);
const eventIdFor = (requestId: string, transition: string) => stableId("uqe", `${requestId}:${transition}`);

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function validString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validTimestamp(value: unknown): value is string {
  if (!validString(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}
function validAnswer(value: unknown): value is Answer {
  if (!record(value) || !exact(value, ["question", "selected_option_ids", "selected_labels"], ["free_text"])) return false;
  return validString(value.question) && Array.isArray(value.selected_option_ids) && value.selected_option_ids.every(validString) && new Set(value.selected_option_ids).size === value.selected_option_ids.length && Array.isArray(value.selected_labels) && value.selected_labels.every(validString) && value.selected_labels.length === value.selected_option_ids.length && (value.free_text === undefined || typeof value.free_text === "string");
}
function validQuestion(value: unknown): value is NormalizedQuestion {
  if (!record(value) || !exact(value, ["question", "header", "options", "multiSelect"])) return false;
  if (!validString(value.question) || !validString(value.header) || value.header.length > 20 || typeof value.multiSelect !== "boolean" || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 4) return false;
  const ids = new Set<string>();
  return value.options.every((option) => {
    if (!record(option) || !exact(option, ["id", "label"], ["description"]) || !validString(option.id) || !validString(option.label) || ids.has(option.id) || (option.description !== undefined && typeof option.description !== "string")) return false;
    ids.add(option.id); return true;
  });
}
function validEvent(value: unknown): value is QuestionEvent {
  if (!record(value) || !exact(value, ["version", "eventId", "requestId", "occurredAt", "type", "payload"])) return false;
  if (value.version !== 1 || !validString(value.eventId) || !validString(value.requestId) || !validTimestamp(value.occurredAt) || !validString(value.type) || !record(value.payload)) return false;
  const payload = value.payload;
  let identity: string;
  if (value.type === "question.created") {
    if (!exact(payload, ["originatingToolCallId", "delivery", "urgency", "questions"]) || !validString(payload.originatingToolCallId) || value.requestId !== requestIdFor(payload.originatingToolCallId) || (payload.delivery !== "blocking" && payload.delivery !== "non_blocking") || (payload.urgency !== "low" && payload.urgency !== "normal" && payload.urgency !== "high") || !Array.isArray(payload.questions) || payload.questions.length < 1 || payload.questions.length > 4 || !payload.questions.every(validQuestion)) return false;
    identity = "created";
  } else if (value.type === "question.answered") {
    if (!exact(payload, ["answers"]) || !Array.isArray(payload.answers) || !payload.answers.every(validAnswer)) return false;
    identity = "answered";
  } else if (value.type === "question.withdrawn") {
    if (!exact(payload, [], ["reason"]) || (payload.reason !== undefined && typeof payload.reason !== "string")) return false;
    identity = "withdrawn";
  } else if (value.type === "question.answer_delivered") {
    if (!exact(payload, ["terminalEventId"]) || !validString(payload.terminalEventId)) return false;
    identity = `delivered:${payload.terminalEventId}`;
  } else if (value.type === "question.escalated" || value.type === "question.declined") {
    if (!exact(payload, [])) return false;
    identity = value.type === "question.escalated" ? "escalated" : "declined";
  } else return false;
  return value.eventId === eventIdFor(value.requestId, identity);
}

export class QuestionService {
  private requests = new Map<string, QuestionRequest>();
  private eventIds = new Set<string>();
  readonly diagnostics: string[] = [];

  clear(): void { this.requests.clear(); this.eventIds.clear(); this.diagnostics.length = 0; }
  project(values: unknown[]): void { this.clear(); for (const value of values) this.applyUnknown(value); }
  applyUnknown(value: unknown): boolean {
    if (!validEvent(value)) { this.note("Ignored malformed or unsupported question event"); return false; }
    return this.apply(value);
  }
  apply(event: QuestionEvent): boolean {
    if (this.eventIds.has(event.eventId)) return false;
    const current = this.requests.get(event.requestId);
    if (event.type === "question.created") {
      if (current || event.requestId !== requestIdFor(event.payload.originatingToolCallId) || !Array.isArray(event.payload.questions)) return this.invalid(event);
      this.requests.set(event.requestId, { requestId: event.requestId, originatingToolCallId: event.payload.originatingToolCallId, delivery: event.payload.delivery, urgency: event.payload.urgency, state: "pending", questions: event.payload.questions, createdAt: event.occurredAt, updatedAt: event.occurredAt, revision: 1, answerDelivered: false });
      this.eventIds.add(event.eventId);
      return true;
    }
    if (!current) return this.invalid(event);
    if (event.type === "question.answer_delivered") {
      if (!current.terminalEventId || current.answerDelivered || event.payload.terminalEventId !== current.terminalEventId) return this.invalid(event);
      current.answerDelivered = true; current.updatedAt = event.occurredAt; current.revision++;
      this.eventIds.add(event.eventId);
      return true;
    }
    if (current.state !== "pending") return this.invalid(event);
    if (event.type === "question.escalated") {
      if (current.delivery === "blocking") return false;
      current.delivery = "blocking";
    } else if (event.type === "question.answered") {
      if (event.payload.answers.length !== current.questions.length || event.payload.answers.some((answer, index) => {
        const question = current.questions[index];
        const expectedLabels = answer.selected_option_ids.map((id) => question.options.find((option) => option.id === id)?.label);
        const hasFreeText = answer.free_text !== undefined && answer.free_text.trim().length > 0;
        const invalidSingle = !question.multiSelect && (answer.selected_option_ids.length > 1 || (answer.selected_option_ids.length > 0 && hasFreeText));
        return answer.question !== question.question || (!answer.selected_option_ids.length && !hasFreeText) || invalidSingle || expectedLabels.some((label) => label === undefined) || expectedLabels.some((label, labelIndex) => label !== answer.selected_labels[labelIndex]);
      })) return this.invalid(event);
      current.state = "answered"; current.resolution = { kind: "answered", answers: event.payload.answers }; current.terminalEventId = event.eventId;
    } else if (event.type === "question.declined") {
      current.state = "declined"; current.resolution = { kind: "declined" }; current.terminalEventId = event.eventId;
    } else {
      current.state = "withdrawn"; current.resolution = { kind: "withdrawn", reason: event.payload.reason }; current.terminalEventId = event.eventId;
    }
    current.updatedAt = event.occurredAt; current.revision++;
    this.eventIds.add(event.eventId);
    return true;
  }
  private invalid(event: QuestionEvent): false { this.note(`Ignored invalid ${event.type} for ${event.requestId}`); return false; }
  private note(message: string): void { if (this.diagnostics.length < 20) this.diagnostics.push(message); }

  get(id: string): QuestionRequest | undefined { return this.requests.get(id); }
  all(): QuestionRequest[] { return [...this.requests.values()]; }
  pending(): QuestionRequest[] {
    const urgency = { high: 0, normal: 1, low: 2 } as const;
    return this.all().filter((r) => r.state === "pending").sort((a, b) => Number(a.delivery !== "blocking") - Number(b.delivery !== "blocking") || urgency[a.urgency] - urgency[b.urgency] || a.createdAt.localeCompare(b.createdAt));
  }

  create(toolCallId: string, input: AskInput): Extract<QuestionEvent, { type: "question.created" }> | undefined {
    const requestId = requestIdFor(toolCallId); if (this.get(requestId)) return undefined;
    const questions: NormalizedQuestion[] = input.questions.map((q, qi) => ({ ...q, options: q.options.map((o, oi) => ({ ...o, id: o.id ?? stableId("opt", `${requestId}:${qi}:${oi}`) })) }));
    return { version: 1, type: "question.created", eventId: eventIdFor(requestId, "created"), requestId, occurredAt: iso(), payload: { originatingToolCallId: toolCallId, delivery: input.delivery ?? "blocking", urgency: input.urgency ?? "normal", questions } };
  }
  escalate(id: string): QuestionEvent | undefined { const r = this.get(id); if (!r || r.state !== "pending" || r.delivery === "blocking") return undefined; return this.event(id, "question.escalated", "escalated", {}); }
  answer(id: string, answers: Answer[]): QuestionEvent | undefined { const r = this.get(id); if (!r || r.state !== "pending") return undefined; return this.event(id, "question.answered", "answered", { answers }); }
  decline(id: string): QuestionEvent | undefined { const r = this.get(id); if (!r || r.state !== "pending") return undefined; return this.event(id, "question.declined", "declined", {}); }
  withdraw(id: string, reason?: string): QuestionEvent | undefined { const r = this.get(id); if (!r || r.state !== "pending") return undefined; return this.event(id, "question.withdrawn", "withdrawn", { reason }); }
  delivered(id: string): QuestionEvent | undefined { const r = this.get(id); if (!r?.terminalEventId || r.answerDelivered) return undefined; return this.event(id, "question.answer_delivered", `delivered:${r.terminalEventId}`, { terminalEventId: r.terminalEventId }); }
  private event<T extends QuestionEvent["type"]>(requestId: string, type: T, identity: string, payload: Extract<QuestionEvent, { type: T }>["payload"]): Extract<QuestionEvent, { type: T }> { return { version: 1, type, eventId: eventIdFor(requestId, identity), requestId, occurredAt: iso(), payload } as Extract<QuestionEvent, { type: T }>; }
}

export function envelope(r: QuestionRequest): RequestEnvelope {
  return { request_id: r.requestId, state: r.state, delivery: r.delivery, urgency: r.urgency, ...(r.resolution?.kind === "answered" ? { resolution: { answers: r.resolution.answers } } : {}) };
}
