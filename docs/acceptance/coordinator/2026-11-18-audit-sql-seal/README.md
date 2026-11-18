# Report audit with the SQL seal held

2026-11-18: **PASS** in disposable local PostgreSQL 18.4, Node 22.23.4
and hidden Windows PowerShell 5.1. Native timestamps in the JSON are UTC.
Production and independent-host restoration were outside this rehearsal.

## Integration

`audit-reports <proof-file>` accepts the optional
`FORGE_COORDINATOR_AUDIT_ROLE` (API option `{ auditRole }`). Under the
disposable SQL seal it authenticates with the existing trusted operator's
coordinator connection, then selects the existing `operational_backup`
`NOLOGIN` role inside `REPEATABLE READ READ ONLY`. No grants or LOGIN
attributes are changed by the audit.

The initial login/effective identities must match the configured connection.
The target role must have the required read access without elevated flags,
memberships, ownership in the audited database or of shared objects, or
persistent write/DDL privileges. The role identifier is escaped, and the same
connection must verify the selected effective role and read-only mode before
reading checkpoints. Missing role configuration preserves the original
read-only audit; an explicitly empty or rejected role returns `incomplete`.

The trusted pre-loss receiver proof, bounded inventories, stable reads and
sanitized public outcomes remain required. The audit does not manage either
seal, create tickets, repair files, adopt receipts, requeue jobs or authorize
dispatch. Confirmed report bytes/receipts do not certify completion in Core.

## Disposable acceptance

Fixture initialization creates synthetic Core/state rows and three genuine
reports with receipts before sealing. A separate `NOLOGIN` negative-test role
gets read access and ownership of another sacrificial database before sealing;
the backup role's existing grants remain unchanged. No roles/grants are
changed during the audit.

- Both `complete` calls exit 0 and return identical JSON with three confirmed reports.
- The inert extra entry returns `review_required`, exit 1.
- Ten negatives return `incomplete`, exit 1. Wrong proof and empty role
  cause zero connection attempts; rejected role/context cases never read jobs.
- The isolated shared-owner case is rejected before `SET LOCAL ROLE`.
- PostgreSQL attests `session_user=forge_pilot`,
  `current_user=operational_backup` and `transaction_read_only=on` in
  the actual connection that reads the three checkpoints.
- Core and state observer snapshots each verify their own repeatable-read,
  read-only transaction. Rows, permissions, roles, memberships, receipts,
  report files and admission tickets match before and after each case.
- During auditing there are zero Core, agent or provider calls. Writer login
  denial remains `28000`; backup DML/DDL denial remains `42501` in both databases.
- File and SQL seals remain held with zero resume attempts and writers
  `NOLOGIN` through connection shutdown. The owning wrapper stops and removes
  the source and both private fixture directories. No target starts.

The implementation and independent QA both passed all 13 cases. Five
incompatible restore/live-agent modes were rejected before setup by engineering;
QA independently checked the live-agent rejection without overwriting its
positive evidence. `npm run check` passed 141 tests. The expected Workbench
closed-gate diagnostic appears in native stderr during fixture preparation.

## Evidence and reproduction

[Final native summary](summary.json) records the accepted control-flow correction.
[Independent QA](qa-summary.json) reproduced the same audit, role and snapshot
code before that final move into the opt-in branch; the final branch then passed
all 13 cases again. [Checkout validation](checkout-validation.json) binds both
review stages, actual source hashes, final checks and functional/security reviews.
Published JSON uses LF. Original Windows-byte hashes and logs are retained
under `.run/evidence/audit-sql-seal/`.

From a real Windows worktree on a non-C: volume, with private C: temporary
storage, Node 22.23.4 on PATH and PostgreSQL 18.4 installed:

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -AuditSqlSeal
```

`-AuditSqlSeal` stops before the full backup rehearsal's normal resume path.
It does not run a restore or produce new RPO/RTO measurements. Snapshots are
consistent per database; no joint atomic SQL/filesystem snapshot is claimed.
The privileged operator remains trusted outside the seal's boundary.
Independent-host restoration and its RPO/RTO remain pending.
