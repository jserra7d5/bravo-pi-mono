# Appendix 05 — Example RLM Trajectories

These are summarized walkthroughs from real RLM runs. Useful for sanity-checking how the scaffold should behave, and for understanding the failure modes.

The original paper includes screenshots of each step (in `trajectories/` of the source archive). Here the steps are described in prose.

---

## RLM(GPT-5) on BrowseComp+ Query 74 — **success**, $0.079 total

**Task.** Multi-hop question over 1000 documents (~8.3M tokens). Find the winner of a beauty pageant held during the 13th anniversary of a fish-stew festival in a Filipino township that uses bagoong-style condiment, between 1995–2005.

**Step 1 — Probe with regex.** GPT-5 (root) writes regex queries against the 1000-doc list looking for keywords from the prompt (`"festival"`, `"beauty pageant"`) AND priors it brings (e.g., `"La Union"`).

**Step 2 — One targeted sub-call.** Index 6 of the chunked corpus looks promising; the root launches a single `llm_query` over that chunk, stores the result in `answer6` and prints it. Sub-LM finds `Maria Dalmacio`.

**Step 3 — Two verification sub-calls.** Root double-checks with two more `llm_query` calls. Both confirm. Returns `FINAL(Maria Dalmacio)`. Correct.

**Lesson:** GPT-5-style RLM is conservative — uses **~3 sub-calls total** for an 8M-token task. The root reasons heavily on stdout snippets and uses sub-LMs surgically.

---

## RLM(Qwen3-Coder) on OOLONG-Pairs Query 3 — **failure**, $1.12 total

**Task.** "List all pairs of user IDs where both users have at least one instance with `description and abstract concept` OR `abbreviation`." ~32K tokens of input. Output is also long (potentially many pairs).

**Step 1 — Solid setup, then good answer in code.**
1. Probes `context` (head/tail print, split on newline).
2. Notices Qwen3-Coder tendency: outputs *multiple* code blocks per turn (vs. GPT-5's one-block-per-turn).
3. Classifies each entry by launching sub-LM calls over small chunks (good — avoids context rot).
4. Stores classifications in a variable, then computes the pair-set programmatically with a Python loop.
5. The correct answer is now sitting in a REPL variable.

**Step 2–11 — Doesn't trust itself.**
- Tries `FINAL_VAR(answer)`, but the loop logic doesn't accept it (likely a template mismatch).
- Re-verifies the pair-set, prints first/last pairs, prints stats — repeats this verification cycle 5 more times.
- Eventually, when forced to produce a final answer, the **root LM autoregresses an answer instead of returning the variable it built up**. That answer is wrong.

**Lesson — known failure mode:**
- The `FINAL` vs `FINAL_VAR` distinction is brittle when the model isn't trained for it.
- Qwen3-Coder over-verifies and tends to discard programmatically-built results in favor of root generation.
- The cure is either (a) training the model to be an RLM natively, or (b) tighter scaffold-side rules about when `FINAL_VAR` must be used.

---

## RLM(Qwen3-Coder) on OOLONG Query 212 — **success but wasteful**, $0.38 total

**Task.** Aggregate semantic question: "Is the label `description and abstract concept` more or less common than `numeric value` across all entries?"

**Step 1 — Defines a per-line classifier.** Qwen3-Coder writes a function that calls `llm_query` **per line** of the input. With thousands of lines, this is *thousands* of recursive sub-calls.

**Step 2 — Runs the classifier.** Long blocking execution (sequential sub-calls).

**Final.** Counts the labels; correctly answers `description and abstract concept is less common than numeric value`.

**Lesson:** This is exactly why the Qwen3-Coder system prompt has the extra warning to **batch ~200K chars per `llm_query` call**. Without it, the model defaults to per-item sub-calls. GPT-5 doesn't have this problem (it batches on its own).

---

## RLM(GPT-5) on CodeQA Query 44 — **success**, $0.27 total

**Task.** Pick the correct (multi-choice) statement about a ~900K-token text-to-image LoRA training repo.

**Step 1.** Root partitions the codebase into chunks and dispatches one sub-LM per chunk asking it to look for specific clues (per-statement keywords from the choices).
**Final.** Aggregates the per-chunk findings via one final sub-LM call → answers `1`. Correct.

**Lesson:** For non-information-dense tasks, naive uniform-chunking + per-chunk sub-call + aggregator works cleanly.

---

## Cross-cutting observations

- **GPT-5 is parsimonious with sub-calls; Qwen3-Coder is profligate.** Without prompt warnings, Qwen3-Coder fires `llm_query` per item → 100s–1000s of calls for trivial tasks.
- **Multi-block-per-turn vs. one-block-per-turn.** Qwen3-Coder writes multiple `repl` blocks in a single root turn. GPT-5 writes one block, observes stdout, then writes the next.
- **Filter first, sub-call second.** Both models reach for regex/keyword filtering on `context` before spending tokens on sub-calls.
- **Long-output tasks → variable stitching.** For OOLONG-Pairs, models build the answer by appending sub-LM outputs into a list/dict in the REPL, then return via `FINAL_VAR`. This is the *only* way to produce outputs longer than the model's context window.
