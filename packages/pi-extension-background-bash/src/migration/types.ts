export type RiskLevel = "low" | "medium" | "high";

export type ProfileSelection = {
  root: string;
  profiles?: string[];
  canary?: number;
};

export type ScannedFile = {
  path: string;
  profile: string;
  kind: "config" | "prompt" | "script" | "run-artifact" | "cache" | "unknown";
  activeRunWarning?: string;
  content: string;
};

export type TransformChange = {
  id: string;
  description: string;
  risk: RiskLevel;
  oldText: string;
  newText: string;
};

export type FilePlan = {
  file: ScannedFile;
  changes: TransformChange[];
  skippedReason?: string;
};

export type MigrationPlan = {
  root: string;
  dryRun: boolean;
  createdAt: string;
  files: FilePlan[];
};

export type BackupEntry = {
  originalPath: string;
  backupPath: string;
  transformIds: string[];
};

export type BackupManifest = {
  version: 1;
  createdAt: string;
  root: string;
  entries: BackupEntry[];
};
