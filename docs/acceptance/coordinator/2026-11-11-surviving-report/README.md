# Surviving report without either checkpoint

The native Windows rehearsal ran on 2026-11-11 with Node 22.23.4, disposable
PostgreSQL 18.4 and a loopback protocol fixture. It used synthetic data and the
existing `Test-FORGE-CoordinatorPilot.ps1 -JointRestore` acceptance path.

The regression places an immutable report in the pinned receiver while both the
prepared output and receipt are absent. The coordinator marks the claimed job
`failed / EFFECT_UNCONFIRMED`. The Core port records only the readiness check,
and the task, executions, memories and continuation state remain intact at the
point of rejection. The handler and provider receive zero calls for that task.
The report keeps its original bytes, device, inode and modification time.

The next task for the same project and agent completes, and a further claim
returns idle with the blocked job still on its first attempt. The same native
run also reconciles a restored report with its original receipt.

The process exited 0. All 24 native tests and the exact limited-role test passed.
The loopback listener was closed and no new fixture directories remained.
`npm run check` also passed on the applied checkout.

| Evidence | SHA-256 |
| --- | --- |
| [Native exit, assertions and cleanup](native-summary.json) | `80a552cb4f88820ec9b8bd822a2ea0fe219667c3f6896010c8b87eec7269e786` |
| [Isolated fixture result](fixture-result.json) | `14e4afe25ddf01090e169c5068cbca869e8b195fdf62b10849e698c99fc03b1f` |

The [regression](../../../../packages/coordinator/tests/native.test.ts#L489)
contains the assertions for both tasks. The independent-host restoration
and remote RPO/RTO remain pending.
