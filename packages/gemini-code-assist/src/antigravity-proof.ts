#!/usr/bin/env node
import { generateAntigravityText } from './antigravity-client.js';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) return process.argv[index + 1];
  return undefined;
}

function redactRaw(raw: string): string {
  return raw.replace(/"thoughtSignature"\s*:\s*"[^"]+"/g, '"thoughtSignature":"<redacted>"');
}

async function runCase(name: string, thinkingBudget?: number, includeThoughts?: boolean, thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'): Promise<void> {
  const prompt = argValue('prompt') ?? `Reply exactly ANTIGRAVITY_${name}_OK`;
  const result = await generateAntigravityText({
    prompt,
    timeoutMs: Number(argValue('timeout-ms') ?? 60000),
    thinkingBudget,
    includeThoughts,
    thinkingLevel,
    model: argValue('model'),
  });
  console.log(JSON.stringify({
    case: name,
    text: result.text,
    modelVersions: result.modelVersions,
    thoughtSignatures: result.thoughtSignatures,
    usageMetadata: result.usageMetadata.at(-1),
  }, null, 2));
  if (process.argv.includes('--raw')) console.log(redactRaw(result.raw));
}

const mode = argValue('mode') ?? 'default';
if (mode === 'sweep') {
  await runCase('DEFAULT');
  await runCase('NO_THINKING', 0, false);
  await runCase('BUDGET_128', 128, false);
  await runCase('BUDGET_1024', 1024, false);
  await runCase('LEVEL_MINIMAL', undefined, false, 'MINIMAL');
  await runCase('LEVEL_HIGH', undefined, false, 'HIGH');
} else {
  const budgetText = argValue('thinking-budget');
  const includeText = argValue('include-thoughts');
  const levelText = argValue('thinking-level') as 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | undefined;
  await runCase('ONE', budgetText === undefined ? undefined : Number(budgetText), includeText === undefined ? undefined : includeText === 'true', levelText);
}
