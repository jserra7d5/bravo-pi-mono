import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AffinityStore } from './affinity.js';

/** PostCompact is awaited by Claude before it sends the compacted context. */
export function handlePostCompact(input: unknown, stateRoot: string): number {
  if (!input || typeof input !== 'object') throw new Error('expected PostCompact hook input');
  const event = input as Record<string, unknown>;
  if (event.hook_event_name !== 'PostCompact' ||
      typeof event.session_id !== 'string' || event.session_id.trim().length === 0) {
    throw new Error('expected PostCompact hook input with a session_id');
  }
  return new AffinityStore({ stateRoot }).clearSession(event.session_id);
}

export function installCompactionHook(settingsPath: string, cliPath: string): void {
  let settings: Record<string, any> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Claude settings must be an object');
  }
  const hooks = settings.hooks ?? {};
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('hooks must be an object');
  const postCompact = hooks.PostCompact ?? [];
  if (!Array.isArray(postCompact)) throw new Error('PostCompact hooks must be an array');
  // POSIX shell quoting: paths may contain spaces, quotes, or shell syntax.
  const command = `'${cliPath.replaceAll("'", "'\\''")}' post-compact`;
  if (!postCompact.some(entry => entry?.hooks?.some((hook: any) => hook.type === 'command' && hook.command === command))) {
    postCompact.push({ hooks: [{ type: 'command', command, timeout: 10 }] });
  }
  settings.hooks = { ...hooks, PostCompact: postCompact };
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, settingsPath);
}
