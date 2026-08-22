# Debate Metadata

- Question: How should the Claude and Codex subscription-auth balancers be redesigned so session affinity, provider-native transport behavior, retry safety, attribution, and observability are correct without forcing unlike provider systems into a dishonest shared runtime abstraction?
- Rounds: 2
- Positions:
  - Position A: shared behavioral contract with provider-native implementations
  - Position B: shared affinity and attempt-state kernel
  - Position C: transport fidelity first and minimal intervention
- Moderator: root-session lead
- Judge: independent non-debater agent
- Decision: Position A architecture with Position B's executable vocabulary/validators and Position C's fail-closed ambiguity rule
- Dissent preserved: see `synthesis.md` minority report and each position transcript
- Artifacts:
  - `brief.md`
  - `position-a.md`
  - `position-b.md`
  - `position-c.md`
  - `synthesis.md`
  - `meta.md`
