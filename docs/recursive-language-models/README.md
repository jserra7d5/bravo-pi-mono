# Recursive Language Models (RLMs)

**Paper:** Recursive Language Models
**Authors:** Alex L. Zhang, Tim Kraska, Omar Khattab (MIT CSAIL)
**arXiv:** 2512.24601v2
**Code:** https://github.com/alexzhang13/rlm

> Audience for this summary: an agent who needs to **figure out and reproduce/extend the technique**. This file is the operational summary; the appendices below contain the full reusable artifacts (system prompts, training recipe, baseline definitions, benchmark specs, example trajectories).

---

## TL;DR

A **Recursive Language Model (RLM)** is a model-agnostic *inference-time scaffold* that lets an LLM process arbitrarily long prompts (10M+ tokens demonstrated) by:

1. **Never putting the user prompt $P$ into the LLM's context window.** Instead, $P$ is loaded as a variable inside a **persistent Python REPL environment** that the model interacts with by writing code.
2. **Giving the LLM a `llm_query(...)` function inside the REPL** so its own code can recursively call sub-LLMs over programmatic slices of $P$.
3. **Only feeding back metadata** (prefix + length of stdout) to the root model each turn — never raw stdout — forcing it to rely on REPL variables and sub-calls.

The output is also unbounded: the model writes its final answer into a REPL variable (`FINAL_VAR(name)`) rather than autoregressing it.

---

## The Core Idea

> Treat the prompt as **part of the environment**, not part of the context window.

### Algorithm 1: RLM core loop

```
Input:  prompt P
Output: response Y

state ← InitREPL(prompt = P)               # P loaded as a variable
state ← AddFunction(state, sub_RLM_M)      # exposes llm_query(...) in REPL
hist  ← [Metadata(state)]                  # only metadata, not P itself

while True:
    code              ← LLM_M(hist)        # root model writes Python
    state, stdout     ← REPL(state, code)  # execute in persistent REPL
    hist              ← hist || code || Metadata(stdout)   # only short prefix + length of stdout

    if state[Final] is set:
        return state[Final]
```

### Why this works (three design choices that distinguish RLMs from "similar" scaffolds)

The paper contrasts this with a deceptive look-alike algorithm (CodeAct-style ReAct + sub-LLM action) and pinpoints three flaws:

| Flaw in naive scaffold                                                                                                                | Fix in RLM                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Flaw #1:** Puts $P$ directly into LLM history. Inherits context-window limit; falls back to compaction.                             | Give the LLM a **symbolic handle** to $P$ via a REPL variable; root model never sees $P$ raw.                               |
| **Flaw #2:** Asks model to autoregress its final answer (`Finish` action). Output is bounded by context window.                       | Final answer is set into a **REPL variable**; can be arbitrarily long (built up programmatically + via sub-calls).          |
| **Flaw #3:** Code execution and sub-LLM are *separate* actions. Sub-LLM can only be invoked with explicitly-verbalized text prompts.  | **Symbolic recursion:** code running inside the REPL can call `llm_query(...)` programmatically — `for chunk in chunks: llm_query(...)` etc. |

The third point is what unlocks $\Omega(|P|)$ and even $\Omega(|P|^2)$ semantic work over the prompt.

---

## Headline Results

Tested with two frontier models:
- **GPT-5** (with sub-calls to GPT-5-mini)
- **Qwen3-Coder-480B-A35B**

Across 4 long-context benchmarks of varying complexity:

| Benchmark           | Length   | Complexity   | Best baseline → RLM (GPT-5)            |
| ------------------- | -------- | ------------ | -------------------------------------- |
| **CodeQA** (LongBench-v2)         | 23K–4.2M | Repo QA      | 58 → **62**                            |
| **BrowseComp+ (1K docs)**         | 6M–11M   | Multi-hop QA | 70.5 → **91.3**                        |
| **OOLONG** (trec_coarse)          | 131K     | Linear       | 46 → **56.5** (+28% over base GPT-5)   |
| **OOLONG-Pairs** (synthetic)      | 32K      | Quadratic    | 24.7 → **58.0** (base GPT-5: ~0.1%!)   |

**Cost:** Median RLM run is *cheaper* than median base GPT-5 run, but tail variance is high (long trajectories). RLMs are up to **3× cheaper than the summary-agent baseline** and outperform it.

### Trained model: RLM-Qwen3-8B
- Distilled 1,000 filtered trajectories from RLM(Qwen3-Coder-480B) on **LongBenchPro** (an unrelated domain).
- Used the `prime-rl` library, batch size 64, 300 steps, **48 H100-hours**.
- **Improves Qwen3-8B as an RLM by 28.3% on average** across all 4 eval tasks (out-of-domain).
- Approaches GPT-5 quality on three of the four tasks.

Key training insight: *Sub-call models are basically just general-purpose LLMs; the hard part is training the **root** model to manipulate the REPL well.* So you only need to train the root behavior — short-horizon and tractable.

---

## Implementation Cheat Sheet

If you're building this:

1. **REPL environment** — persistent Python session. Initialize with two things:
   - `context` variable holding the user prompt (as `str`, `List[str]`, or whatever structure makes sense for the task).
   - `llm_query(prompt: str) -> str` function the model can call from its code.
2. **Code-block protocol** — model wraps Python in <code>```repl ... ```</code> fences. Server extracts and runs each block in the persistent session.
3. **Output truncation** — only return a *short prefix + length* of stdout to the model on each turn. This is the load-bearing trick: it forces the model to use REPL variables instead of dumping data to stdout.
4. **Final answer protocol** — model signals completion with one of:
   - `FINAL(literal answer text)` — direct answer.
   - `FINAL_VAR(variable_name)` — return a REPL variable's value (lets output exceed context window).
5. **Sub-call quota** — for models that over-call (e.g., Qwen3-Coder), add an instruction to **batch ~200K chars per `llm_query`** rather than one call per item. See [system prompts](appendices/01-system-prompts.md).
6. **Recursion depth** — paper uses **depth = 1** (sub-calls are vanilla LLMs, not sub-RLMs). Deeper recursion is left as future work.
7. **Sub-call concurrency** — paper uses *blocking/sequential* sub-calls. Going async is the obvious latency win and is flagged as future work.

---

## Emergent Patterns Observed in Trajectories

Even without training, models display recurring strategies (Section 4.4 of paper):

- **Filtering with code first.** Models use `regex` and keyword search over the `context` variable to narrow down chunks *before* spending sub-calls. They lean on their priors (e.g., GPT-5 searched for "La Union" and "festival" because it suspected the topic).
- **Uniform chunking + recursive sub-calls.** Most decompositions are simple (split by newline, every N chars, by Markdown headers). No sophisticated partitioning observed.
- **Stitching outputs through REPL variables.** For long-output tasks (OOLONG-Pairs), models store sub-LM outputs in a list/dict variable and combine them, then return via `FINAL_VAR`.

---

## Limitations / Known Failure Modes

- Tradeoff at small context: base LLM beats RLM on short prompts. RLMs win once length × complexity grows.
- Cost variance is large; pathological trajectories can run long (especially Qwen3-Coder, which over-uses sub-calls without a warning prompt).
- `FINAL` vs `FINAL_VAR` distinction is brittle — Qwen3-Coder often verifies in a loop without ever emitting `FINAL_VAR`, then returns a wrong root-generated answer instead of the variable it built. See [appendix on negative results](appendices/06-negative-results.md).
- Synchronous sub-calls = slow. Need async to be production-viable.
- Models without strong coding ability (e.g., raw Qwen3-8B) struggle to act as the root.
- Reasoning models with small max-output budgets get killed by thinking tokens (e.g., Qwen3-235B-A22B).

---

## Appendices (full reusable resources)

| File | Contents |
| ---- | -------- |
| [01-system-prompts.md](appendices/01-system-prompts.md) | **All system prompts**: RLM (GPT-5), Qwen3-Coder diff, Qwen3-8B diff, RLM-no-sub-calls, CodeAct + BM25, CodeAct, plus how the summary agent is set up. |
| [02-methods-and-baselines.md](appendices/02-methods-and-baselines.md) | Methods/baselines compared (CodeAct + BM25, CodeAct + sub-calls, summary agent, RLM, RLM no-sub-calls). |
| [03-training.md](appendices/03-training.md) | Full training recipe for RLM-Qwen3-8B (data collection, filtering, fixing template mistakes, hyperparameters). |
| [04-benchmarks.md](appendices/04-benchmarks.md) | Benchmark specs: S-NIAH, BrowseComp+, OOLONG, OOLONG-Pairs (with all 20 questions), CodeQA. |
| [05-example-trajectories.md](appendices/05-example-trajectories.md) | Walkthroughs of real RLM runs (BrowseComp+, OOLONG-Pairs, OOLONG, CodeQA) including the failure mode from RLM(Qwen3-Coder). |
| [06-negative-results.md](appendices/06-negative-results.md) | "Things we tried that did not work" — every gotcha worth knowing before re-implementing. |
| [07-runtime-cost.md](appendices/07-runtime-cost.md) | Cost/runtime distributions, why sequential calls hurt, cost-scaling vs. context length. |
