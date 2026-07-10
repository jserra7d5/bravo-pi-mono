export const Exit = { SUCCESS:0, USAGE:2, DEPENDENCY:3, CONFLICT:4, INGRESS:5, RUNTIME:6, PROOF:7 } as const;
export class WorkspaceError extends Error {
  constructor(public readonly code:string, message:string, public readonly exitClass:number, public readonly details?:unknown, options?:ErrorOptions){ super(message, options); this.name="WorkspaceError"; }
}
export function asWorkspaceError(value:unknown):WorkspaceError { return value instanceof WorkspaceError ? value : new WorkspaceError("INTERNAL", "Unexpected workspace failure", Exit.RUNTIME); }
