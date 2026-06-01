export function killProcessTree(pid: number, signal: NodeJS.Signals | "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
  if (process.platform !== "win32") {
    try { process.kill(-pid, signal); return; } catch {}
  }
  try { process.kill(pid, signal); } catch {}
}

export async function terminateProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL" = "SIGTERM", killAfterMs = 5_000): Promise<void> {
  killProcessTree(pid, signal);
  if (signal !== "SIGKILL" && killAfterMs > 0) {
    setTimeout(() => killProcessTree(pid, "SIGKILL"), killAfterMs).unref?.();
  }
}
