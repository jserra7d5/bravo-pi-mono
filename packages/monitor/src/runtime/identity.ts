import type { MonitorRecord } from "../schema/types.js";

export type MonitorRuntimeIdentity = {
  session_id?: string;
  root_session_id?: string;
  workspace_id?: string;
};

export function getRuntimeIdentity(ctx?: any): MonitorRuntimeIdentity {
  return {
    session_id: ctx?.sessionManager?.getSessionFile?.() ?? process.env.PI_SESSION_ID,
    root_session_id: process.env.TANGO_ROOT_SESSION_ID ?? process.env.PI_ROOT_SESSION_ID,
    workspace_id: process.env.TANGO_WORKSTREAM_ID ?? process.cwd(),
  };
}

export function monitorBelongsToRuntime(monitor: MonitorRecord, identity: MonitorRuntimeIdentity): boolean {
  const owner = monitor.owner ?? {};

  if (monitor.scope === "session") {
    return !!owner.session_id && !!identity.session_id && owner.session_id === identity.session_id;
  }

  if (monitor.scope === "root_session") {
    // Prefer Pi's stable session file. Tango root IDs can be shared by delegated agents,
    // but only the owning Pi conversation should receive wake follow-ups.
    if (owner.session_id && identity.session_id) return owner.session_id === identity.session_id;
    return !!owner.root_session_id && !!identity.root_session_id && owner.root_session_id === identity.root_session_id;
  }

  if (monitor.scope === "workspace") {
    // Workspace paths are not a safe wake target: multiple agents routinely share cwd.
    // Workspace-scoped monitors remain listable, but execution/wake ownership is still
    // bound to the stable creating session when available.
    if (owner.session_id && identity.session_id) return owner.session_id === identity.session_id;
    return !!owner.root_session_id && !!identity.root_session_id && owner.root_session_id === identity.root_session_id;
  }

  return false;
}
