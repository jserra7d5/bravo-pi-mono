import { resolve } from "node:path";

export interface BackgroundBashConfig {
  enabled: boolean;
  dataDir?: string;
  defaultMaxRuntimeMs?: number;
  defaultMaxOutputBytes?: number;
  idleTimeoutMs?: number;
  shutdownPolicy?: "kill-session-tasks" | "leave-running";
  notifyModelOnCompletion?: boolean;
  notifyUiOnCompletion?: boolean;
  promptBlockBehavior?: "mark-blocked" | "stop";
  retentionDays?: number;
}

export interface ResolvedBackgroundBashConfig extends Required<Omit<BackgroundBashConfig, "dataDir">> {
  dataDir: string;
}

export function readConfig(raw: unknown, cwd = process.cwd()): ResolvedBackgroundBashConfig {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as BackgroundBashConfig;
  const envEnabled = process.env.PI_BACKGROUND_BASH_ENABLED === "1" || process.env.PI_BACKGROUND_BASH_ENABLED === "true";
  return {
    enabled: Boolean(cfg.enabled ?? envEnabled),
    dataDir: resolve(cwd, cfg.dataDir ?? ".pi/background-bash"),
    defaultMaxRuntimeMs: cfg.defaultMaxRuntimeMs ?? 30 * 60 * 1000,
    defaultMaxOutputBytes: cfg.defaultMaxOutputBytes ?? 10 * 1024 * 1024,
    idleTimeoutMs: cfg.idleTimeoutMs ?? 0,
    shutdownPolicy: cfg.shutdownPolicy ?? "kill-session-tasks",
    notifyModelOnCompletion: cfg.notifyModelOnCompletion ?? false,
    notifyUiOnCompletion: cfg.notifyUiOnCompletion ?? true,
    promptBlockBehavior: cfg.promptBlockBehavior ?? "mark-blocked",
    retentionDays: cfg.retentionDays ?? 7,
  };
}

export function configFromContext(ctx: unknown, cwd = process.cwd()): ResolvedBackgroundBashConfig {
  const raw = (ctx as { config?: { backgroundBash?: unknown; piExtensionBackgroundBash?: unknown } } | undefined)?.config;
  return readConfig(raw?.backgroundBash ?? raw?.piExtensionBackgroundBash, cwd);
}
