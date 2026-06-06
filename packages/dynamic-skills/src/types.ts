export type DynamicSkill = {
  name: string;
  description: string;
  location: string;
  baseDir: string;
  discoveredFrom: string;
  discoveredAt: string;
};

export type Diagnostic = {
  type: "native-path-duplicate" | "native-name-collision" | "dynamic-name-collision" | "invalid-skill" | "security-boundary";
  name?: string;
  location?: string;
  message: string;
  at: string;
};

export type DynamicSkillSnapshot = {
  version: 1;
  skills: DynamicSkill[];
  diagnostics: Diagnostic[];
  pending?: DynamicSkill[];
};

export type NativeSkill = { name?: unknown; filePath?: unknown; path?: unknown; location?: unknown; baseDir?: unknown };
