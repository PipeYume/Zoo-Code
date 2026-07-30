# Task Delegation Formal Model

This directory contains a small TLA+ model for the task-delegation state machine.

The model is intentionally abstract. It does not model VS Code, webviews, prompt contents, provider implementations, or task message history. It only models the state that must remain consistent while a parent task delegates work to a child task:

- parent task liveness while a child is created
- child focus after creation
- semaphore reservation and release
- rollback after child creation or history persistence failures
- parent and child API profile isolation
- parent history status after delegation

## Local Checks

The executable CI check lives in `src/core/task/__tests__/delegation-state-machine.spec.ts`. It exhaustively explores the same small state machine with Vitest and includes explicit negative controls for the highest-risk invariant violations:

- broadcasting a child provider-profile change to the live parent
- leaking a reserved permit after failed child creation
- failing to restore a suspended parent after serial child creation fails

Run it with:

```bash
pnpm --dir src exec vitest run core/task/__tests__/delegation-state-machine.spec.ts
```

## TLA+ Checks

The TLA+ spec can be checked with TLC from the TLA+ Toolbox, the VS Code TLA+ extension, or a CLI TLC installation:

```bash
java -cp /path/to/tla2tools.jar tlc2.TLC TaskDelegation.tla -config TaskDelegation.cfg
```

The main invariants are:

- `PermitBound`: held plus reserved permits never exceed the configured concurrency.
- `ParentProfileIsolation`: a live parent keeps its original API profile.
- `ChildProfileIsolation`: a live child uses the child API profile.
- `RollbackRestoresParent`: failed delegation releases reservations and returns focus to the parent.
- `RunningChildHasDelegatedParent`: a running child implies the parent history item is delegated.

## Drift Control

The Vitest model is the primary drift monitor because it runs with the normal test suite. If production delegation behavior changes, update the Vitest model and this TLA+ model in the same change.

Reviewers should check this mapping when touching delegation code:

- `TaskScheduler.tryReserve()` / `runWithReservation()` map to the `reservedPermit` and `permitsHeld` transitions.
- `delegateParentAndOpenChild()` maps to the parent liveness, child creation, focus, rollback, and history transitions.
- provider-profile switching maps to `globalProfile`, `parentLocalProfile`, and `childLocalProfile`.
- task-history updates map to `parentHistoryStatus` and `childHistoryStatus`.

Run TLC locally for changes that alter delegation ordering, rollback, profile switching, or scheduler permits. For smaller implementation-only changes, the Vitest model plus targeted unit/e2e coverage is usually sufficient.

## State-Machine Review Checklist

Use this checklist for changes that touch delegation, task focus, scheduler permits, provider profile or mode switching, task-local API configuration, or rollback behavior.

Before coding, state the invariant the change is preserving. Example: "provider/profile mutations are serialized; a timed-out caller must not allow a later mutation to overtake an earlier one."

For every async or mutating fix, answer:

- Does a timeout cancel the work, or only stop waiting for it?
- If timed-out work can still complete later, can it mutate state after a newer operation?
- Can a later mode/profile mutation overtake an earlier one?
- Does rejection poison the queue, skip queued work, or create an unhandled rejection?
- If a required setup step fails, does delegation abort or continue?
- If rollback fails, what live task, focused task, history status, and reserved permits remain?
- Does rollback route through the same queue or lock that may already be blocked?
- Does any code read shared provider state where task-local state is required?
- Does any webview push re-derive the focused task when the operation is about a different task?

Required tests for these changes:

- A positive test for the intended path.
- A negative test that would fail with the original bug.
- A fix-interaction test that would fail if the fix introduces a stale completion, queue overtake, leaked permit, or rollback-of-rollback failure.

Any timeout around a mutating async operation must prove one of these two properties:

- the underlying operation is actually cancelled before later conflicting mutations can run; or
- later conflicting mutations remain queued until the timed-out operation truly settles.
