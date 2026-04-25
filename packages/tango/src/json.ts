export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function ok(data: Record<string, unknown> = {}, json = false): void {
  if (json) printJson({ ok: true, ...data });
}

export function fail(message: string, json = false, code = 1): never {
  if (json) printJson({ ok: false, error: message });
  else console.error(`tango: ${message}`);
  throw process.exit(code);
}
