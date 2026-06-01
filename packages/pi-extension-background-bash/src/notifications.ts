import type { BackgroundTaskRecord } from "./task-types.js";

export function completionMessage(task: BackgroundTaskRecord): string {
  return `[BACKGROUND BASH COMPLETE — NOT USER INPUT]\nTask: ${task.taskId}\nStatus: ${task.status}\nOutput: ${task.outputPath}`;
}
