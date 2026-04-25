# Appendix 03 — Training RLM-Qwen3-8B

The first natively-recursive language model, trained as a small-scale demonstration that the RLM behavior can be distilled cheaply.

## The key insight

> Sub-call models are essentially general-purpose LLMs. The hard part is teaching the **root** model to manipulate the REPL and decide when to launch sub-calls.

So the training recipe focuses on the *root* turn — short-horizon, tractable at small scale. Trajectories are sliced into individual root iterations and trained as standard SFT samples.

## Recipe

### 1. Generate trajectories with a stronger teacher
- Teacher: **Qwen3-Coder-480B-A35B-Instruct** (used as an RLM, with itself for sub-calls).
- Domain: **LongBenchPro** (English split, 750 tasks). *Critically: this is unrelated to any of the four eval benchmarks (CodeQA, BrowseComp+, OOLONG, OOLONG-Pairs) — the gains transfer out-of-domain.*
- Each task → 3 candidate trajectories → **2,250 candidates total**.

### 2. Filter trajectories
1. **Drop scoring-zero or single-turn trajectories.** Leaves **1,072 candidates**.
2. **Slice each multi-turn trajectory into per-turn samples**: input = full history at turn $t$, output = the LLM's actual completion at turn $t$. Each turn is one SFT example.
3. **Drop turns whose history exceeds the student's context** — approximated as 100K characters for Qwen3-8B.

### 3. Programmatic template-fixup
The teacher (Qwen3-Coder) frequently flubs the RLM output template. Two common errors observed:
- **16% of turns** had a malformed `FINAL(answer)` (e.g., wrapped a variable name in `FINAL` instead of `FINAL_VAR`).
- **13% of turns** wrote `FINAL_VAR(literal_text)` instead of `FINAL(literal_text)`.

The authors wrote a small fixup pass that pattern-matches these mistakes and rewrites them before training. This **materially improved** the distilled model's ability to terminate cleanly.

### 4. Fine-tune
- Library: **`prime-rl`** (Prime Intellect).
- Base model: Qwen3-8B.
- Batch size: **64**.
- Steps: **300**.
- Compute: **48 H100-hours**.
- No RL, no online rollouts — pure SFT distillation.

### 5. Evaluate as an RLM
The student (`RLM-Qwen3-8B`) is then *itself* deployed as the root LLM in the standard RLM scaffold (with Qwen3-8B sub-calls). It's evaluated on the four held-out benchmarks.

## Result

| Task          | Qwen3-8B base | Qwen3-8B as RLM | RLM-Qwen3-8B |
| ------------- | ------------- | ---------------- | ------------- |
| CodeQA        | 4.0           | 26.0             | **32.0**      |
| BrowseComp+   | 0.0           | 2.0              | **14.0**      |
| OOLONG        | 0.0           | 24.0             | **32.0**      |
| OOLONG-Pairs  | 0.1           | 4.3              | **5.2**       |

- **Median +28.3% over Qwen3-8B-as-RLM**, despite training on a completely different domain.
- Inference cost goes *down* because the trained model makes fewer wasted sub-calls.

## What this implies

Training native RLMs at *real* scale (more model size, more diverse trajectories, on-policy/online rollouts) is flagged as a promising new axis of inference scaling. The connection drawn: an RLM trajectory can be viewed as a form of reasoning, much like CoT/o1-style traces — bootstrappable similarly to STaR / Quiet-STaR.
