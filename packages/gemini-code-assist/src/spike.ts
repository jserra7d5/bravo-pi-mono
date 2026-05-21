#!/usr/bin/env node
import { generateCodeAssistText } from './code-assist-client.js';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const prompt = readArg('--prompt') ?? 'Say hello from Code Assist OAuth.';
  const model = readArg('--model') ?? 'gemini-3.5-flash';
  const timeoutRaw = readArg('--timeout-ms');
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error('--timeout-ms must be a positive number.');

  const text = await generateCodeAssistText({ prompt, model, timeoutMs });
  process.stdout.write(`${text}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Never print credential objects or token values; only surface concise error text.
  console.error(`gemini-code-assist spike failed: ${message}`);
  process.exitCode = 1;
});
