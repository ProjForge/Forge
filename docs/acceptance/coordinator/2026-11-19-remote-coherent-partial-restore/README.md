# Same-host partial restore and clean retry

Windows rehearsal on 2026-11-19. Source HEAD `3624c0ae4f1ad2c361c90baaa402926df679dfbc` and `main` commit `797d1c0` have the same tree, `af9ded9588526c120b68698d8ff6078d35f7b507`. The rehearsal used Node 22.23.4 and PostgreSQL 18.4 with pgvector.

| Stage | Native exits | Observation |
| --- | --- | --- |
| Capture | postgres 0, initdb 0, pg_ctl start 0, role setup and test 0/0, pg_dump 0/0, pg_ctl stop 0 | Three scoped report receipts at the sealed cut. Both database writer-denial probes returned SQLSTATE 42501 for DDL and DML. |
| Partial restore | initdb 0, pg_ctl start 0, Core pg_restore 0, coordinator pg_restore 1, pg_ctl stop 0 | Stopped at `restore-both`. Core had three committed projects. The coordinator schema was absent. No report creation, reconciliation, worker, agent or accepted kit result. |
| Clean retry | initdb 0, pg_ctl start 0, pg_restore 0/0, role setup and test 0/0, pg_ctl stop 0 | New cluster identifier. Seven table hashes and counts matched the cut. All three report byte sequences and receipts matched. One pending job completed, two completed jobs stayed unchanged, and all subsequent attempts returned idle. Zero handler or provider replay. |

The harness uses the kit restore and cleanup functions. It stages copies with scratch paths and import locations adjusted, plus a read-only SQL observer after failure. The opt-in fault truncated a separate plaintext copy from 5,354 to 2,677 bytes after all four components authenticated. The original coordinator archive and the encrypted replica stayed intact. The same transfer pin validated before both attempts and again after retry. The observer checked the resulting SQL state after the nonzero exit. It did not instrument the exact archive instruction at which PostgreSQL encountered the truncation.

The harness exited 0. The partial target injected an admin close rejection immediately after the actual connection closed. The harness stopped the cluster through the staged kit stop function, then invoked cleanup again and verified exactly one native stop. The clean retry used the normal kit cleanup. PowerShell independently verified scratch removal and connection refusal on ports 65480 (source), 65510 (failed target) and 65528 (retry). The transfer tests passed 14/14 and the three TypeScript workspace builds exited 0. See [sanitized run data](run.json) for hashes and exit codes.

From the worktree root, build `forge-persistence-gateway`, `forge-coordinator` and `forge-resilience` with the installed dependencies. Set `$nodeExe` to the Node 22.23.4 executable. The fixture uses PostgreSQL 18.4 with pgvector installed under `C:\Program Files\PostgreSQL\18`.

```powershell
& $nodeExe scripts/acceptance/Test-RemoteCoherentPartialRestore.mjs --exercise-partial-restore
```

Scope covers same-host, same-account module execution with loopback-only PostgreSQL. Windows Sandbox, the launcher, separate SIDs and custody ACLs remain outside this run. The same Node process retains the unwrapped key in memory for both attempts. The full launcher destroys rsa.pem with its disposable environment. A fresh custody session would require an authorized rewrap or a recreated handoff. Fresh custody and remote restoration remain unverified.
