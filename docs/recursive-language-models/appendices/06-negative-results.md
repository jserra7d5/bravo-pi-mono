# Appendix 06 — Negative Results & Gotchas

> "Things we tried that did not work" — annotated from the paper. Read this *before* reimplementing.

## 1. Don't reuse one RLM system prompt across model families
The authors wrote the canonical RLM system prompt with in-context examples tailored for **GPT-5**. Reusing it verbatim for **Qwen3-Coder** produced bad behavior — Qwen3-Coder fires hundreds-to-thousands of recursive sub-calls because nothing tells it to batch. **Fix:** add the "batch ~200K chars per `llm_query`" warning (see [01-system-prompts.md](01-system-prompts.md), section 1b).

## 2. Models without strong coding ability struggle as RLMs
Small/weak coders (e.g., raw Qwen3-8B) can't write the Python needed to manipulate the REPL effectively. The RLM scaffold is **only as good as the root model's coding ability**. This is the bottleneck the trained `RLM-Qwen3-8B` is meant to address.

## 3. Reasoning models with small max-output budgets get cut off
Tried `Qwen3-235B-A22B` (a thinking model). Even when accuracy improved over base (~30% → ~38% on OOLONG), trajectories died because thinking tokens consumed the per-call output budget before the model could finish writing its REPL code or its `FINAL` block. Either: increase max output tokens, or use non-thinking variants for the root.

## 4. Sequential sub-calls are slow
The authors implemented all `llm_query` calls as **blocking**. RLM trajectories that issue many sub-calls (especially Qwen3-Coder) are noticeably slower than the base model on the same task. **Fix is obvious: async sub-call dispatch.** They flag this as the main practical engineering work for production deployment.

## 5. `FINAL` vs `FINAL_VAR` is a brittle output protocol
The current way to signal "I'm done" is wrapping the answer in `FINAL(...)` or `FINAL_VAR(...)`. Common failure modes:
- Model puts its *plan* in `FINAL(...)` instead of an answer.
- Model wraps a variable name in `FINAL(...)` instead of `FINAL_VAR(...)` (or vice versa) — these were the two big classes of error in the teacher trajectories used to train RLM-Qwen3-8B (16% and 13% of turns).
- Qwen3-Coder will produce a correct answer in a REPL variable, never call `FINAL_VAR`, then eventually emit a wrong root-generated answer when forced to terminate (see OOLONG-Pairs trajectory in [appendix 05](05-example-trajectories.md)).

The authors added small server-side safeguards but believe the right fix is **training models natively as RLMs**, where this protocol is part of the training distribution.

## 6. Cost variance is high
Median RLM cost is competitive (often cheaper than the base model), but the **tail is fat** — pathological trajectories (especially on info-dense tasks) can burn 10× the budget. Plan capacity accordingly. See [appendix 07](07-runtime-cost.md).

## 7. Performance on short prompts can be *worse* than the base model
For inputs comfortably within the base model's context window (especially S-NIAH-style $O(1)$ tasks at small lengths), the base LM beats the RLM. The RLM has strictly more representational capacity by construction, but in practice the scaffold overhead/missteps cost more than they buy. **Use the RLM only past a length-and-complexity threshold.**

## 8. Recursion depth = 1 is what's actually evaluated
"Sub-call" means a vanilla LLM, not another RLM. Depth-2+ recursion is left as future work.

## 9. Quadratic-aggregation tasks are easy to accidentally make linear
While building OOLONG-Pairs, the authors found many "all pairs satisfying X" questions can be solved without enumerating pairs (e.g., via inclusion-exclusion). They explicitly designed the 20 questions to require true pair enumeration. If you build new pair-style benchmarks, **check that linear shortcuts don't exist**.
