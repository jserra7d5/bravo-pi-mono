export interface BrowserWorkspaceConfigV1 {
  schemaVersion: 1;
  workspace: string;
  listenHost: "127.0.0.1";
  listenPort: number;
  tmuxSocketName: string;
  tmuxSessionName: string;
  tailscaleHttpsPort: number;
  executables: { ttyd: string; tmux: string; tailscale: string; pi?: string };
}
export interface ExternalCommand { executable: string; args: readonly string[]; env?: NodeJS.ProcessEnv }
export interface ConfigInitData { configPath: string; created: true; mode: "0600" }
export interface IngressInspectData {
  desired: { httpsPort: number; target: `http://127.0.0.1:${number}` };
  state: "absent" | "exact" | "conflict" | "unavailable";
  url?: string;
  funnelPresent: boolean;
  warning: string;
}
export interface StatusData {
  configPath: string;
  tmux: { socketName: string; sessionName: string; exactSessionExists: boolean; serverPid?: number };
  ttyd: { host: "127.0.0.1"; port: number; ready: boolean };
  ingress: { state: IngressInspectData["state"]; url?: string };
}
