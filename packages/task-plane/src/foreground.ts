import { createBashTool } from "@earendil-works/pi-coding-agent";

export async function executeForeground(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) {
  const cwd = typeof (ctx as { cwd?: unknown } | undefined)?.cwd === "string" ? (ctx as { cwd: string }).cwd : process.cwd();
  const bashTool = createBashTool(cwd, {});
  const command = typeof params.command === "string" ? params.command : "";
  const timeout = typeof params.timeout === "number" ? params.timeout : undefined;
  return bashTool.execute(id, { command, timeout }, signal, onUpdate as never);
}
