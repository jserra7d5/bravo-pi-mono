# Appendix 04 — Benchmarks

The eval suite is designed so that *task complexity scales with prompt length differently per benchmark*. The authors explicitly argue that "effective context window" only makes sense relative to a task's complexity profile.

| Benchmark           | Lengths tested | Complexity wrt length | What's tested |
| ------------------- | -------------- | --------------------- | ------------- |
| **S-NIAH**          | $2^{13}$ – $2^{18}$ | $O(1)$               | Find a fixed needle in long noise |
| **BrowseComp+ (1K)**| 6M–11M tokens   | $O(1)$ docs to combine | Multi-hop QA over 1000 docs |
| **OOLONG**          | 131K            | $O(N)$               | Aggregate semantic transformation per item |
| **OOLONG-Pairs**    | 32K             | $O(N^2)$             | Aggregate over *pairs* of items |
| **CodeQA**          | 23K – 4.2M      | mixed                | Multi-choice over a code repo |

## S-NIAH (RULER single needle-in-haystack)

50 tasks. A specific phrase or number hidden in unrelated text. Information-to-find scales as $O(1)$. Fixed evaluation: exact-match / score per RULER convention.

## BrowseComp-Plus (1K docs)

- Multi-hop DeepResearch QA. 150 randomly sampled questions from BrowseComp+ (per Sun et al. 2025).
- Each task gets **1000 randomly chosen docs** as input — guaranteed to contain the gold + evidence + hard negatives.
- Total ~6–11M input tokens per task. Way past base-model context windows.
- Score: % correct.

A 20-task scaling study is also included (the same 20 questions evaluated at increasing doc counts, with two extra baselines: ReAct + GPT-5 + BM25, and GPT-5 fed the BM25 pre-query results). RLM(GPT-5) is the only method that holds 100% accuracy at the 1000-doc scale.

## OOLONG (`trec_coarse` split)

- 50 tasks over a dataset of TREC-style questions tagged with semantic labels (`numeric value`, `entity`, `human being`, `description and abstract concept`, `abbreviation`, `location`).
- Each task requires **transforming nearly every entry** then aggregating → linear complexity.
- Scoring per the OOLONG paper: numeric answers scored as $0.75^{|y - \hat y|}$, others exact-match.

## OOLONG-Pairs (**new in this paper**)

- Modification of `trec_coarse` with **20 new queries** that aggregate over *pairs* of entries → quadratic complexity.
- Scored by F1 over the predicted pair-set.
- Designed to *prevent* solving the task linearly via inclusion-exclusion. Many pair-aggregation queries can be reduced to per-entry counts; the authors specifically wrote questions that resist this.

### All 20 OOLONG-Pairs questions

The available labels every question references:
`description and abstract concept`, `entity`, `human being`, `numeric value`, `location`, `abbreviation`.

Each answer is "all pairs `(user_id_1, user_id_2)` where `user_id_1 < user_id_2`, separated by newlines."

1. Both users have at least one instance with **numeric value** OR **location**.
2. Both users have at least one instance with **entity** OR **human being**.
3. Both users have at least one instance with **description and abstract concept** OR **abbreviation**.
4. Both users have at least one instance with **human being** OR **location**, AND every `human being` instance for both users is **after January 6, 2023**.
5. Both users have at least one instance with **entity** OR **numeric value**, AND every `entity` instance for both users is **before March 15, 2023**.
6. Both users have at least one instance with **location** OR **abbreviation**.
7. Both users have at least one instance with **description and abstract concept** OR **numeric value**, AND every `numeric value` instance for both users is **after February 1, 2023**.
8. Both users have at least one instance with **human being** OR **description and abstract concept**.
9. Both users have at least one instance with **entity** OR **location**, AND every `location` instance for both users is **after April 10, 2023**.
10. Both users have at least one instance with **numeric value** OR **abbreviation**, AND every `abbreviation` instance for both users is **before May 20, 2023**.
11. One user has ≥1 `entity` AND ≥1 `abbreviation`; the other has **exactly one** `entity`.
12. One user has ≥2 `numeric value`; the other has ≥1 `location` AND ≥1 `human being`.
13. One user has **exactly one** `description and abstract concept`; the other has ≥1 `abbreviation` AND ≥1 `entity`.
14. One user has ≥1 `human being` AND ≥1 `numeric value`; the other has **exactly two** `location`.
15. One user has ≥1 `entity`, ≥1 `location`, ≥1 `abbreviation`; the other has **exactly one** `numeric value`.
16. One user has ≥1 `description and abstract concept` AND ≥1 `human being`; the other has ≥2 `entity` AND **exactly one** `abbreviation`.
17. One user has **exactly one** `numeric value`; the other has ≥1 `location` AND ≥1 `description and abstract concept`.
18. One user has ≥1 `abbreviation` AND **exactly one** `human being`; the other has ≥1 `entity` AND ≥1 `numeric value`.
19. One user has ≥2 `location` AND ≥1 `entity`; the other has **exactly one** `description and abstract concept` AND **exactly one** `abbreviation`.
20. One user has ≥1 `numeric value` AND ≥1 `human being`; the other has ≥1 `location`, ≥1 `entity`, **exactly one** `abbreviation`.

OOLONG-Pairs context lengths covered: `[1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576]`.

## LongBench-v2 CodeQA

- Multi-choice (4 choices) repo-understanding split from LongBench-v2.
- Score: % correct.
- Context lengths: 23K–4.2M tokens. Fixed number of files needed per question.

## LongBenchPro (training-only)

Used **only for collecting trajectories to train RLM-Qwen3-8B**. Not in the eval table. 750 English tasks, 3 trajectories each from RLM(Qwen3-Coder-480B).
