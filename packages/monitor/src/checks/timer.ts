import type { MonitorRecord, MonitorResult } from "../schema/types.js";
import { generateResultId } from "../ids.js";
import { nowISO } from "../time.js";

export async function runTimerCheck(_record: MonitorRecord, _signal?: AbortSignal): Promise<MonitorResult> {
  return {
    result_id: generateResultId(),
    monitor_id: _record.monitor_id,
    status: "matched",
    observation: { now: nowISO() },
    condition_matched: true,
    triggered: true,
    created_at: nowISO(),
  };
}
