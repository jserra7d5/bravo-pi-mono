# Appendix 07 — Runtime and Cost

All numbers are with **blocking/sequential** sub-LM calls. Async would change runtime materially but not API cost.

## Cost shape

- **Median:** RLM cost ≈ base-model cost on tasks that fit, *cheaper* than summary-agent on every task (up to ~3×).
- **Tails:** RLM costs are long-tailed. The 75th and 95th percentiles can be much higher than median, especially on info-dense tasks (OOLONG-Pairs) where the model launches many sub-calls.
- For Qwen3-Coder runs, the **summary-agent baseline is up to ~20× more expensive** than RLM on BrowseComp+ because Qwen3-Coder is used for *every* compaction step (vs. GPT-5-nano for the GPT-5 baseline).

## Worked numbers

- **BrowseComp+ (1K)** with GPT-5-mini ingesting 6–11M input tokens (linearly extrapolated): **\$1.50–\$2.75** per query. RLM(GPT-5) average: **\$0.99**, with **+29%** quality over the summary/retrieval baselines.
- See Table 1 in [README](../README.md) for per-task `(score, mean cost ± std)` across all methods.

## Runtime

- Runtimes are **highly implementation-dependent** (machine, API latency, async). The paper's runtimes are reported but caveated heavily.
- Long-tail RLM trajectories dominate the wall-clock distribution.
- **Mitigations called out by the authors:**
  - **Async sub-LM dispatch** — biggest single win.
  - **Sandboxed REPL** — would let recursive sub-calls run in parallel REPLs.
  - **Prompt the model to write fewer / shorter code blocks** — reduces per-turn LM round-trips.

## Cost vs. context length (S-NIAH / OOLONG / OOLONG-Pairs)

Across the $2^{13}$ → $2^{18}$ scaling sweep, RLM cost grows **proportionally to task complexity** (constant / linear / quadratic), but stays in the same order of magnitude as base-model cost when the base model can handle the input at all. Past the base-model context limit, the comparison flips entirely — base GPT-5 cannot run; RLM continues to scale.

## Tradeoff guidance

- For **short or simple tasks**: prefer the base model. RLM has overhead and small but real failure modes that cost more than they buy.
- For **long context but constant-needle tasks** (S-NIAH-style at large length): RLM is competitive; either can win.
- For **information-dense tasks** (OOLONG, OOLONG-Pairs) at any length where the base model degrades: RLM dominates. Quality gap is double-digit, cost is comparable.
- For **tasks past the model's context window**: RLM is the only option that doesn't fall back to lossy compaction.
