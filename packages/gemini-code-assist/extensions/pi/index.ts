import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  createAssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ANTIGRAVITY_CLIENT_ID,
  antigravityClientSecret,
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_SCOPES,
  antigravityMethodUrl,
  antigravityStreamUrl,
  buildAntigravityHeaders,
  defaultAntigravityCredentialsPath,
  getAntigravityAccessToken,
  refreshAntigravityCredentials,
  resolveAntigravityProject,
  type AntigravityCredentials,
} from "../../src/antigravity-client.js";

const PROVIDER = "antigravity-code-assist";
const API = "google-generative-ai" as Api;
const PUBLIC_HIGH_MODEL_ID = "gemini-3.5-flash";
const PUBLIC_MEDIUM_MODEL_ID = "gemini-3.5-flash-medium";
const FILE_BACKED_AUTH_SENTINEL = "antigravity-code-assist-file";

function upstreamModelId(modelId: string): string {
  if (modelId === PUBLIC_HIGH_MODEL_ID) return ANTIGRAVITY_DEFAULT_MODEL;
  if (modelId === PUBLIC_MEDIUM_MODEL_ID) return "gemini-3.5-flash-low";
  return modelId;
}

function sanitize(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function convertPart(content: TextContent | ImageContent): Record<string, unknown> {
  if (content.type === "text") return { text: sanitize(content.text) };
  return { inlineData: { mimeType: content.mimeType, data: content.data } };
}

function convertMessages(context: Context, model: Model<any>): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  const sameModel = (msg: AssistantMessage) => msg.provider === model.provider && msg.model === model.id;

  for (const msg of context.messages as Message[]) {
    if (msg.role === "user") {
      const parts = typeof msg.content === "string"
        ? [{ text: sanitize(msg.content) }]
        : msg.content.map(convertPart);
      if (parts.length) contents.push({ role: "user", parts });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: Record<string, unknown>[] = [];
      const keepSignatures = sameModel(msg);
      for (const block of msg.content) {
        if (block.type === "text") {
          if (!block.text.trim()) continue;
          parts.push({
            text: sanitize(block.text),
            ...(keepSignatures && block.textSignature ? { thoughtSignature: block.textSignature } : {}),
          });
        } else if (block.type === "thinking") {
          if (!block.thinking.trim()) continue;
          parts.push({
            text: sanitize(block.thinking),
            ...(keepSignatures ? { thought: true } : {}),
            ...(keepSignatures && block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
          });
        } else if (block.type === "toolCall") {
          parts.push({
            functionCall: { name: block.name, args: block.arguments ?? {} },
            ...(keepSignatures && block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
          });
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "toolResult") {
      const text = msg.content.filter((item): item is TextContent => item.type === "text").map((item) => item.text).join("\n");
      const images = model.input.includes("image") ? msg.content.filter((item): item is ImageContent => item.type === "image").map(convertPart) : [];
      const response = msg.isError ? { error: sanitize(text) } : { output: sanitize(text || (images.length ? "(see attached image)" : "")) };
      const part = { functionResponse: { name: msg.toolName, response, ...(images.length ? { parts: images } : {}) } };
      const last = contents.at(-1) as { role?: unknown; parts?: unknown[] } | undefined;
      if (last?.role === "user" && last.parts?.some((p: any) => p.functionResponse)) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    }
  }

  return contents;
}

function convertTools(tools: Tool[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters,
    })),
  }];
}

function thinkingConfig(options?: SimpleStreamOptions): Record<string, unknown> | undefined {
  switch (options?.reasoning) {
    case undefined:
      return { includeThoughts: false, thinkingLevel: "HIGH" };
    case "minimal":
      return { includeThoughts: false, thinkingLevel: "MINIMAL" };
    case "low":
      return { includeThoughts: false, thinkingLevel: "LOW" };
    case "medium":
      return { includeThoughts: false, thinkingLevel: "MEDIUM" };
    case "high":
    case "xhigh":
      return { includeThoughts: false, thinkingLevel: "HIGH" };
  }
}

async function accessToken(options?: SimpleStreamOptions): Promise<string> {
  if (options?.apiKey && options.apiKey !== FILE_BACKED_AUTH_SENTINEL) return options.apiKey;
  return getAntigravityAccessToken(defaultAntigravityCredentialsPath(), fetch);
}

function authHeaders(token: string): Record<string, string> {
  return buildAntigravityHeaders(token);
}

function mapStopReason(reason: string | undefined): "stop" | "length" | "error" {
  if (reason === "MAX_TOKENS") return "length";
  if (!reason || reason === "STOP") return "stop";
  return "error";
}

function streamAntigravity(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: API,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const token = await accessToken(options);
      const project = await resolveAntigravityProject(token, fetch);
      const generationConfig: Record<string, unknown> = {};
      if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
      if (options?.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
      const thinking = thinkingConfig(options);
      if (thinking) generationConfig.thinkingConfig = thinking;

      const body = {
        project,
        requestId: `agent/pi/${Date.now()}/${crypto.randomUUID()}/1`,
        model: upstreamModelId(model.id),
        request: {
          contents: convertMessages(context, model),
          ...(context.systemPrompt ? { systemInstruction: { role: "user", parts: [{ text: sanitize(context.systemPrompt) }] } } : {}),
          ...(context.tools?.length ? { tools: convertTools(context.tools), toolConfig: { functionCallingConfig: { mode: "AUTO" } } } : {}),
          ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
          sessionId: String(Date.now()),
        },
        userAgent: "antigravity",
        requestType: "agent",
      };

      stream.push({ type: "start", partial: output });
      const response = await fetch(antigravityStreamUrl(), { method: "POST", headers: authHeaders(token), body: JSON.stringify(body), signal: options?.signal });
      if (!response.ok) throw new Error(`Antigravity generation failed: HTTP ${response.status}: ${await response.text()}`);
      const raw = await response.text();
      let openTextIndex: number | undefined;
      const finishText = () => {
        if (openTextIndex === undefined) return;
        const block = output.content[openTextIndex];
        if (block?.type === "text") stream.push({ type: "text_end", contentIndex: openTextIndex, content: block.text, partial: output });
        openTextIndex = undefined;
      };

      for (const event of raw.replace(/\r\n/g, "\n").split("\n\n")) {
        const line = event.split("\n").find((item) => item.startsWith("data:"));
        if (!line) continue;
        const data = JSON.parse(line.slice(5).trim()) as any;
        const responsePayload = data.response;
        output.responseId ||= responsePayload?.responseId;
        output.responseModel ||= responsePayload?.modelVersion;
        const candidate = responsePayload?.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text !== undefined) {
            if (part.thought === true) {
              // Antigravity currently returns thought signatures, not visible thought text, when includeThoughts=false.
              continue;
            }
            if (openTextIndex === undefined) {
              output.content.push({ type: "text", text: "", ...(part.thoughtSignature ? { textSignature: part.thoughtSignature } : {}) });
              openTextIndex = output.content.length - 1;
              stream.push({ type: "text_start", contentIndex: openTextIndex, partial: output });
            }
            const block = output.content[openTextIndex];
            if (block?.type === "text") {
              block.text += part.text;
              if (part.thoughtSignature) block.textSignature = part.thoughtSignature;
              if (part.text) stream.push({ type: "text_delta", contentIndex: openTextIndex, delta: part.text, partial: output });
            }
          }
          if (part.functionCall) {
            finishText();
            const toolCall: ToolCall = {
              type: "toolCall",
              id: part.functionCall.id ?? `${part.functionCall.name}_${Date.now()}`,
              name: part.functionCall.name ?? "",
              arguments: part.functionCall.args ?? {},
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            };
            output.content.push(toolCall);
            const contentIndex = output.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex, partial: output });
            stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
            stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
          }
        }
        if (candidate?.finishReason) output.stopReason = mapStopReason(candidate.finishReason);
        if (output.content.some((block) => block.type === "toolCall")) output.stopReason = "toolUse";
        if (responsePayload?.usageMetadata) {
          const usage = responsePayload.usageMetadata;
          output.usage = {
            input: (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0),
            output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
            cacheRead: usage.cachedContentTokenCount ?? 0,
            cacheWrite: 0,
            totalTokens: usage.totalTokenCount ?? 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          calculateCost(model, output.usage);
        }
      }
      finishText();
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (output.stopReason === "error" || output.stopReason === "aborted") throw new Error("Antigravity generation stopped with error");
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const redirectUri = "http://localhost:17177/oauth-callback";
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  callbacks.onAuth({ url: url.toString() });
  const input = await callbacks.onPrompt({ message: "Paste the full localhost callback URL or the code= value:" });
  const code = input.includes("code=") ? new URL(input).searchParams.get("code") : input.trim();
  if (!code) throw new Error("No OAuth code provided.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: ANTIGRAVITY_CLIENT_ID, client_secret: antigravityClientSecret(), code, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  if (!response.ok) throw new Error(`Antigravity OAuth exchange failed: ${await response.text()}`);
  const data = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number };
  return { access: data.access_token, refresh: data.refresh_token ?? "", expires: Date.now() + (data.expires_in ?? 3600) * 1000 - 300_000 };
}

async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const refreshed = await refreshAntigravityCredentials({ access_token: credentials.access, refresh_token: credentials.refresh, expiry_date: credentials.expires } satisfies AntigravityCredentials, defaultAntigravityCredentialsPath(), fetch);
  return { access: refreshed.access_token ?? "", refresh: refreshed.refresh_token ?? credentials.refresh, expires: refreshed.expiry_date ?? Date.now() + 3600_000 };
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER, {
    name: "Antigravity Code Assist",
    baseUrl: ANTIGRAVITY_ENDPOINT,
    apiKey: FILE_BACKED_AUTH_SENTINEL,
    api: API,
    streamSimple: streamAntigravity,
    oauth: { name: "Antigravity Code Assist", login, refreshToken, getApiKey: (credentials) => credentials.access },
    models: [
      {
        id: PUBLIC_HIGH_MODEL_ID,
        name: "Gemini 3.5 Flash",
        reasoning: true,
        thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high" },
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
      {
        id: PUBLIC_MEDIUM_MODEL_ID,
        name: "Gemini 3.5 Flash (Medium)",
        reasoning: true,
        thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high" },
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
    ],
  });
}
