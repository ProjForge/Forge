# Windows Sandbox partial restore with fresh custody

The 2026-11-20 rehearsal used the repository tree `ded7ffcb8232397fbb9f2f599e6346ed51563bad` shared by `main` at `5b85f3d` and local checkout `e008817`. The offline kit used Node 22.23.4, PostgreSQL 18.4 and pgvector.

| Stage | Native outcome | Verified result |
| --- | --- | --- |
| Source | Capture exited 0 | A sealed generation held both dumps and three reports with receipts. The source removed its cluster and original plaintext. Its Sandbox closed before either destination started. |
| Destination A | Core restore 0, coordinator restore 1, launcher 1 | A staged fixture truncated a separate plaintext copy of the coordinator archive after authenticating all four components. A read-only query found three committed Core projects and no coordinator schema. Reconciliation never ran. |
| Destination B | Previous handoff rejected at verification. Core restore 0, coordinator restore 0, launcher 0 | A new standard custodian and fresh cluster restored the same encrypted generation. Seven table hashes and all three report byte hashes and receipts matched. The one pending job reconciled once. Both completed jobs stayed completed. The handler and provider replay counts were zero. |

Both destinations ran the direct Windows VM launcher and checked custody file ACLs under limited accounts. The noncustodian received Win32 access-denied code 5. Cleanup removed the keys, plaintext, temporary accounts and scheduled tasks. The target ports stopped listening. All three Sandboxes were closed and the final host inventory was empty.

The source wrapped its synthetic data key to a test recovery RSA key held only in host process memory. For each destination, the host relay authenticated the source generation, unwrapped the data key, wrapped it to that destination's independently checked public key and cleared the data-key buffer. The encrypted inventory and logical run and generation IDs stayed identical. The envelope and pinned transfer manifest changed for each recipient. The old handoff was rejected by `Submit-VmReplica.ps1 -VerifyOnly` before the second destination accepted a restore request or provisioned PostgreSQL.

The first execution stopped before PostgreSQL startup with loader error `0xC0000135`. Rebuilding with the previously verified portable runtime supplied the missing DLLs. The next execution restored both databases but found the same local SID in the two cloned Sandboxes. In the final execution a disabled temporary user consumed one RID in the second guest and was removed before launching the kit. The final check verified distinct destination SIDs, public-key fingerprints and PostgreSQL cluster identifiers.

This evidence covers a new destination custody session on one physical host. The recovery relay was synthetic and host-local. Independent-host restoration and remote RPO and RTO remain pending. See the [sanitized native results](result.json).
