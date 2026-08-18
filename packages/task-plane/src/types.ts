export type TaskStatus = "running"|"blocked"|"completed"|"failed"|"stopped"|"timed_out"|"orphaned";
export type TerminalTaskStatus = Extract<TaskStatus,"completed"|"failed"|"stopped"|"timed_out">;
export type StopReason = "timeout"|"output_cap"|"event_flood"|"user"|"interactive_prompt";
export type DispatchState = "dispatch_requested"|"host_api_invoked"|"dispatch_sync_failed";
export type AttemptPhase = "claimed"|"starting"|"running"|"closing"|"outcome_pending"|"suspension_requested"|"suspended";

/** Durable v3 task metadata. Paths are retained for inspection, but are always
 * validated against paths derived from task_id before use. */
export interface TaskRecord {
 schema_version:3; record_version:number; task_id:string; type:"bash"|"monitor"; mode?:"stream"|"interval"; name?:string; command:string; cwd:string;
 status:TaskStatus; output_path:string; metadata_path:string; started_at:string; updated_at:string; ended_at?:string; deadline_at?:string;
 owner_session_id:string; owner_session_file?:string; owner_runtime_id?:string; pid?:number; pgid?:number; exit_code?:number; signal?:string;
 stop_reason?:StopReason; blocked_reason?:string; output_bytes:number; max_output_bytes:number; max_runtime_s?:number;
 interval_s?:number; command_timeout_s?:number; until_output_matches?:string; throttle_s?:number; idempotency_key?:string;
 next_run_at?:string; last_hash?:string; event_timestamps?:number[]; suspended_at?:string; attempt?:number; attempt_id?:string; attempt_phase?:AttemptPhase; suspension_pending?:boolean; suspension_requested_at?:string; suspension_completed_at?:string;
 dispatch_state?:DispatchState; dispatch_requested_at?:string; host_api_invoked_at?:string; dispatch_error?:string; notification_suppressed_reason?:"shutdown";
 lease_token?:string; lease_attempt_id?:string; lease_owner_runtime_id?:string; lease_expires_at?:string;
 stop_requested_at?:string; stop_request_id?:string; stop_requested_signal?:"SIGTERM"|"SIGKILL"; stop_requested_reason?:StopReason; stop_requested_kill_after_s?:number; stop_request_deadline_at?:string; stop_acknowledged_at?:string; stop_acknowledged_by_runtime_id?:string;
 stdio_drain_timed_out?:boolean; failure_reason?:"command_timeout";
}

export interface AdmissionDraft {
 type:"bash"|"monitor"; mode?:"stream"|"interval"; name?:string; command:string; cwd:string;
 owner_session_id:string; owner_session_file?:string; max_output_bytes:number; max_runtime_s?:number;
 interval_s?:number; command_timeout_s?:number; until_output_matches?:string;
 idempotency_key?:string; deadline_at?:string; started_at?:string;
}
export type LeaseClaimResult=
 | {outcome:"acquired";record:TaskRecord}
 | {outcome:"contended";record:TaskRecord}
 | {outcome:"unclaimable";record:TaskRecord;status:TerminalTaskStatus|"orphaned"};
export type ToolResponse={content:Array<{type:"text";text:string}>;details:Record<string,unknown>;isError?:boolean};
