export const QUESTION_PROMPT = `Use \`ask_user_question\` when a meaningful user decision would improve or unblock the work.

- Choose \`blocking\` when the immediate next action cannot be taken safely without the answer, especially before irreversible, costly, or materially divergent work.
- Choose \`non_blocking\` when independent work can continue and the answer can be incorporated later.
- Urgency controls user attention, not whether execution blocks: \`low\` is a future refinement, \`normal\` is useful without an immediate deadline, and \`high\` is needed soon because work is approaching a decision boundary.
- After creating a non-blocking request, continue useful independent work. Do not poll, repeat the question, or ask it again in prose.
- If a pending answer becomes necessary, call \`wait_for_user_question\` once.
- Withdraw requests that become obsolete.
- Treat a delivered answer event as authoritative and do not re-ask it.
- Batch related decisions into one request, keep labels concise, put a recommended option first, and do not include an Other option because the UI supplies free text.`;
