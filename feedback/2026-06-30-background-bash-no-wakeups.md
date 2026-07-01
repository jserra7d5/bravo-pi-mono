# Background bash failures do not wake the agent

Date: 2026-06-30

## Complaint

Background bash currently records workload failure but does not wake the agent. This is a severe operator-experience failure for long-running tests/builds.

The harness even reports:

> Model wake-up notification delivery is not implemented; do not rely on background bash to wake the model.

That means the correct tool for long-running workloads is also unable to notify the agent when those workloads complete or fail. The agent must manually poll `background_task_status` or wait for the user to ask, which causes avoidable idle time and makes failures look silent.

## Why this is bad

- Tests/builds are exactly the jobs where completion/failure should resume the agent.
- Monitor is explicitly not supposed to run workloads, so it is not a valid replacement.
- The agent can miss failures for minutes or indefinitely unless the user prompts it.
- This breaks fast-track workflows and makes async orchestration feel unreliable.
- The UX is especially bad because the task output exists, but the control plane never surfaces it.

## Requested fix

Implement wake-up delivery for managed background bash tasks, at minimum for terminal state transitions:

- completed successfully
- failed/non-zero exit
- timed out
- killed/stopped

Ideally include the task id, exit code, output path, and tail of stderr/stdout in the wakeup.

## Priority

High. This is not polish; it directly impacts agent autonomy and operator trust.
