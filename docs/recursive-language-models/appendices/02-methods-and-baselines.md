# Appendix 02 — Methods and Baselines

All methods are **task-agnostic** (no per-task tuning). Models tested:
- **GPT-5** (medium reasoning, default sampling). Paired sub-call model: **GPT-5-mini**.
- **Qwen3-Coder-480B-A35B** (Fireworks-hosted; sampling per the model card).
- **Qwen3-8B** (base + the trained `RLM-Qwen3-8B`).

---

## Method roster

### 1. Base Model
LLM gets the prompt directly. No scaffolding, no system prompt. Crashes on inputs > context window.

### 2. CodeAct (+ BM25)
ReAct-style loop with two actions: execute Python, or `SEARCH(query)` against a BM25 index built over the input corpus. Used for BrowseComp+ (multi-doc QA). The user prompt is **placed directly in the LLM context** — this is one of the key differences vs. RLM. See [Algorithm 2 / "bad scaffold"](#algorithm-2-the-anti-pattern-rlms-fix).

### 3. CodeAct with sub-LM calls (no BM25)
Same as CodeAct but with a `sub_LLM(...)` action exposed alongside Code execution. Sub-call is invoked with **explicitly verbalized text** by the model — not programmatically inside a loop. This is the ablation that isolates **flaw #3** (no symbolic recursion).

### 4. Summary agent
Iteratively accumulates input until the model context is full, summarizes, continues. If a document exceeds the window, it chunks first. For GPT-5: uses **GPT-5-nano** for compaction, GPT-5 for the final answer (cost reasons; quality validated as comparable on a 20-sample BrowseComp+ subset).

Mirrors how Claude Code, ReSum, MemAgent, Context Folding compact context in long-running agents.

### 5. RLM with REPL (the proposed method)
- Persistent Python REPL with `context` (the prompt) and `llm_query(...)` (sub-LLM call) preloaded.
- Root model writes Python in <code>```repl</code> blocks.
- Only stdout *metadata* (short prefix + length) goes back to root each turn.
- Final answer via `FINAL(...)` or `FINAL_VAR(...)`.
- For GPT-5 experiments, sub-calls go to **GPT-5-mini** (root = GPT-5). Notation: `RLM(GPT-5)`.

### 6. RLM with REPL — no sub-calls (ablation)
Same as RLM but without `llm_query`. Isolates the contribution of *recursive sub-calling* vs. just having the prompt in a REPL. Surprisingly strong on tasks where keyword filtering plus regex is enough (CodeQA), much weaker on info-dense tasks (OOLONG-Pairs).

### 7. Fine-tuning → RLM-Qwen3-8B
See [appendix 03](03-training.md) for the full recipe.

---

## Algorithm 1: RLM (the design)

```
Input:  prompt P
Output: response Y

state ← InitREPL(prompt = P)
state ← AddFunction(state, sub_RLM_M)        # adds llm_query(...)
hist  ← [Metadata(state)]                    # only metadata; P stays in REPL

while True:
    code              ← LLM_M(hist)
    state, stdout     ← REPL(state, code)
    hist              ← hist || code || Metadata(stdout)
    if state[Final] is set:
        return state[Final]
```

## Algorithm 2: the anti-pattern RLMs fix

The CodeAct-with-sub-call style:

```
actions ← {Finish, Exec, Search, sub_LLM_M}
hist    ← [Metadata(actions), P]                  # ⚠ Flaw #1 — P in context

while True:
    (action, val) ← LLM_M(hist)
    if action == Finish:
        return val                                # ⚠ Flaw #2 — output bounded by ctx
    out  ← RUN(action, val)                       # ⚠ Flaw #3 — sub-LLM is a fixed action,
                                                  #    not callable from inside code
    hist ← hist || (action, val, out)
    if Tok(hist) > K:
        hist ← Compact(hist)                      #    falls back to lossy compaction
```

| Flaw | Consequence | RLM's fix |
| ---- | ----------- | --------- |
| #1 — prompt in context | Inherits context-window limit; needs compaction | Prompt as REPL variable; only metadata in hist |
| #2 — `Finish(text)` autoregressed | Output bounded by ctx | `FINAL_VAR(name)` returns a variable's value |
| #3 — sub-LLM as action | Can only verbalize discrete sub-tasks | Sub-LLM is a *Python function* callable inside arbitrary loops |

---

## Cost notes (per author's setup)

- **GPT-5** costs computed at OpenAI list pricing.
- **Qwen3-Coder-480B-A35B** costed via Fireworks.
- For RLM(GPT-5), root is GPT-5 and sub-calls are GPT-5-mini (chosen as a quality/cost knee).
- Median RLM cost ≤ median base-model cost in most experiments; the **tail** is what hurts (long trajectories).
- All sub-LM calls in the paper's implementation are **blocking/sequential** — flagged as the obvious thing to fix for production.
