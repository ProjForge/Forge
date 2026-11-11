# Direct Windows VM restore rehearsal

On 2026-11-11, two sequential network-disabled Windows Sandbox guests exercised
the source capture and the direct VM destination. Both guests ran on one
physical machine. A test-only relay rewrapped the synthetic symmetric key
in memory to the destination's public key between guests. The destination
private key remained in its guest. A remote VM was not provisioned.

- The source captured Core and coordinator archives after the common sealed
  cut. It removed the source cluster and plaintext inputs.
- The destination used a temporary SYSTEM scheduled task to run each phase
  under a standard local account. The same custodian SID generated the key,
  restored the generation and removed private materials. The other standard
  account received Win32 error 5 for the attempted private-key operations.
- Both transactional restores exited 0. Counts and hashes matched in seven
  tables, including the pgvector row. The post-cut marker was absent.
  Reconciliation retained the receipt and report with zero agent calls.
- A separate wrong-key run staged and checked a pinned transfer, rejected
  the envelope before starting PostgreSQL, and removed the key, accounts and
  owned task. Both successful-run guests and the negative-run guest closed.

The fixture used Node 22.23.4 and PostgreSQL 18.4. The runtime was built from
`42031db73e38320889a04d9026af044dcbb03eee`, with identical package and lockfile
contents on integrated `main` at `b8645838316e595bb64c536cd5e7809e3f6dbaba`.
The archive hash in the summary identifies the local rehearsal archive.
Rebuilding a portable kit can change its archive hash.

| Artifact | SHA-256 |
| --- | --- |
| [Source capture](source-result.json) | `9e2e5f585abee2a67bbd980f6c84c3464617374f82a1d8d0d9dd52afff03fc72` |
| [Destination restore](restore-result.json) | `0d9b9db414c1ee187cf5fa02f5ef4bb8532c3543567e8c09014d5ba57da2aea8` |
| [Wrong key rejection](wrong-key-result.json) | `e970969b38aaa730c1ee063628da51176a723fa7fb7121db5c07a28a275d601a` |
| [Summary and archive verification](summary.json) | `de7bff90b2dde38ae71e313f493b54e337fefdb810dd7e6f27b6907a059ec` |

Independent-host restoration, remote custody acceptance and remote RPO/RTO
remain pending. See the [VM rehearsal guide](../../../guides/COHERENT-BACKUP.md#remote-windows-vm-destination).
