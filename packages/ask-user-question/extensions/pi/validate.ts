import type { Question } from "./schema.js";

/**
 * Returns an error message if question texts or option labels are not unique,
 * or null if validation passes.
 */
export function validateUniqueness(questions: Question[]): string | null {
  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.question)) {
      return `Duplicate question: "${q.question}"`;
    }
    seen.add(q.question);

    const labels = new Set<string>();
    const ids = new Set<string>();
    for (const opt of q.options) {
      if (labels.has(opt.label)) {
        return `Duplicate option label "${opt.label}" in question "${q.question}"`;
      }
      if (opt.id && ids.has(opt.id)) {
        return `Duplicate option ID "${opt.id}" in question "${q.question}"`;
      }
      labels.add(opt.label);
      if (opt.id) ids.add(opt.id);
    }
  }
  return null;
}
