import { type Static, Type } from "typebox";

export const DeliverySchema = Type.Union([Type.Literal("blocking"), Type.Literal("non_blocking")]);
export const UrgencySchema = Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")]);

export const OptionSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
  label: Type.String({ description: "Concise display label" }),
  description: Type.Optional(Type.String()),
});
export const QuestionSchema = Type.Object({
  question: Type.String(),
  header: Type.String({ maxLength: 20, description: "Compact topic label (maximum 20 characters)" }),
  options: Type.Array(OptionSchema, { minItems: 2, maxItems: 4 }),
  multiSelect: Type.Boolean(),
});
export const InputSchema = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
  delivery: Type.Optional(DeliverySchema),
  urgency: Type.Optional(UrgencySchema),
});
export const RequestIdInputSchema = Type.Object({ request_id: Type.String({ minLength: 1 }) });
export const WithdrawInputSchema = Type.Object({
  request_id: Type.String({ minLength: 1 }),
  reason: Type.Optional(Type.String()),
});

export type Delivery = Static<typeof DeliverySchema>;
export type Urgency = Static<typeof UrgencySchema>;
export type Option = Static<typeof OptionSchema>;
export type Question = Static<typeof QuestionSchema>;
export type AskInput = Static<typeof InputSchema>;
export type NormalizedOption = Omit<Option, "id"> & { id: string };
export type NormalizedQuestion = Omit<Question, "options"> & { options: NormalizedOption[] };
export type Answer = {
  question: string;
  selected_option_ids: string[];
  selected_labels: string[];
  free_text?: string;
};
export type QuestionResolution = { kind: "answered"; answers: Answer[] } | { kind: "declined" } | { kind: "withdrawn"; reason?: string };
export type RequestState = "pending" | "answered" | "declined" | "withdrawn";
export type QuestionRequest = {
  requestId: string;
  originatingToolCallId: string;
  delivery: Delivery;
  urgency: Urgency;
  state: RequestState;
  questions: NormalizedQuestion[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  resolution?: QuestionResolution;
  terminalEventId?: string;
  answerDelivered: boolean;
};
export type RequestEnvelope = {
  request_id: string;
  state: RequestState;
  delivery: Delivery;
  urgency: Urgency;
  resolution?: { answers: Answer[] };
};

export type PickerOutcome =
  | { kind: "submitted"; answers: Answer[] }
  | { kind: "declined" }
  | { kind: "closed" };

// Durable entry payloads. Each transition has a deterministic event identity.
type EventBase = { version: 1; eventId: string; requestId: string; occurredAt: string };
export type QuestionEvent =
  | (EventBase & { type: "question.created"; payload: { originatingToolCallId: string; delivery: Delivery; urgency: Urgency; questions: NormalizedQuestion[] } })
  | (EventBase & { type: "question.escalated"; payload: Record<string, never> })
  | (EventBase & { type: "question.answered"; payload: { answers: Answer[] } })
  | (EventBase & { type: "question.declined"; payload: Record<string, never> })
  | (EventBase & { type: "question.withdrawn"; payload: { reason?: string } })
  | (EventBase & { type: "question.answer_delivered"; payload: { terminalEventId: string } });
