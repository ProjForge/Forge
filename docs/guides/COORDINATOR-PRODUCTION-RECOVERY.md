# Forge coordinator production recovery policy

**Status** · Proposed design reviewed against `main` `7cc217a` on 2026-11-14.
Production coordinator activation and remote restoration are pending. The
cadence and retention windows below are proposals for approval after measuring
capture duration, recovery time and storage use in preproduction.

## Initial production topology

Use one trusted Windows writer host with one coordinator state store and a
pinned local NTFS report receiver. Keep Core and coordinator state in separate
databases of one PostgreSQL cluster dedicated to Forge, with separate credentials
and schema ownership. Keep the existing Core runtime grants. Scope the pilot to
immutable local reports. The independent recovery destination hosts a replica and can
restore into empty databases under its own recovery identities.

| Boundary | Planned authority |
| --- | --- |
| Core and coordinator runtime | Limited Core role and dedicated state owner. One coordinator state store owns leases for the enrolled workload. The worker publishes only to its pinned receiver. |
| Backup controller and capture | The controller owns admission, drain and SQL sealing. Capture reads the two databases through the narrowly scoped backup reader. Workers have no backup administration, replica deletion or private-key access. |
| Replica destination | A separate host and storage with separate credentials. The origin can submit a new immutable generation through the approved transfer channel. Destination identities verify and publish it. |
| Key custody and retention | A separate custodian authorizes key recovery. A designated retention operator approves deletion or expiry changes and records the evidence. Neither authority belongs to the runtime worker or the origin's replica writer. |

Inventory every writer before approving the topology. Include Gateway, MCP,
Workbench, the embedding worker, the coordinator and its store, report
publication, direct SQL, migrations, scheduled maintenance and any other client
with access to either database or the receiver. Validate each managed entry point
against the same private admission directory and the complete SQL role inventory
for the declared cluster. `NOLOGIN` applies cluster-wide, so verify that the
sealed roles have no consumers outside Forge. The file barrier assumes one trusted
Windows host. Additional writer hosts, independent database clusters or new
receivers need a separately validated cut and fencing design.

## Consistent cut and recovery unit

1. Close managed admissions and drain admitted work through output preparation,
   report publication and receipt commit. Apply and verify the durable SQL seal
   and drain sessions in both databases. Begin capture only after both drains
   pass. Maintain the controller's ownership through capture and publication.
2. Authenticate one generation containing both dumps, the retained report
   payload and receiver/identity manifest. The current four-component format
   proves recovery of the selected confirmed report. Before enabling the intended
   workload, validate coverage of all reports and receipts in its recovery scope
   and record the manifest inventory. Recover both databases and their reports
   from the same generation.
3. Authenticate the complete independent replica before marking the generation
   protected. Budget the transfer and verification time in the planned maintenance
   window. On timeout, lost controller ownership, unknown writer or capture
   failure, keep admission closed and preserve prior generations. The operator
   verifies roles, sessions, tickets, reports and receipts before explicitly
   restoring recorded writer state and resuming admissions. A missing ticket
   holder or elapsed time alone gives no authority to reopen.
4. For restoration, authenticate the replica inventory and original receiver
   proof before provisioning or mutating the target. Verify schema, roles,
   representative data, execution identity, report bytes and receipt on the
   destination. Before dispatch resumes, compare surviving reports, including
   effects after the cut, with the restored receipts. Use `recover-report` for
   a verified replacement receiver with pre-loss proof. `reconcile-report`
   requires the original pinned receiver and already completed Core. Keep
   ambiguous reports and incomplete Core jobs for operator review using
   independent evidence. Any later cutover requires one active writer topology
   and explicit exclusion of the old writer host.
   [Confirmed report recovery](CONFIRMED-REPORT-RECOVERY.md)

The [coherent backup guide](COHERENT-BACKUP.md#operational-gate-acceptance-2026-11-10)
describes the executable fixture and the scope of the SQL seal. Its synthetic
superuser and fixture credentials are not a production identity design.

## Key custody

- Generate a fresh random encryption key per generation. Bind the wrapped key
  to its external `keyId` and register the generation, key ID, trusted public-key
  fingerprint and manifest digest in an integrity-protected record available
  independently of the origin and the bundle. Capture uses the pinned custody
  public key. The custody private key and its recovery copy stay outside the
  origin's administrative domain and the replica writer's reach.
- Designate a named custodian and an independently recoverable custody path.
  Limit unwrap access to the authorized isolated restore process. Audit issuance,
  wraps, unwraps, rotation and retirement without recording key material. Use
  protected, short-lived plaintext staging and verify cleanup. The local
  separate-account rehearsal established NTFS access denial between standard
  accounts on one host. Production key storage and recovery identities still
  need selection and an independent-host test.
- On rotation, use the new custody key for future generations. Keep older keys
  and wrapped records recoverable for every retained or held generation. Before
  retiring a key, check its dependencies and restore with the replacement custody
  arrangement. Record the disposition and keep any generation under an incident
  hold decryptable.

## Independent replica

- Keep the replica in a different host and storage failure domain. Use separate
  credentials and an administrative boundary that prevents origin compromise
  from deleting or rewriting the replica. Confirm these properties for the chosen
  destination, including any immutability and lifecycle settings, before use.
- Transfer ciphertext and the authorized handoff only. Pin the expected
  generation, key ID and manifest digest via a trusted record. Authenticate every
  component at the destination; publish only the complete verified bundle under
  a unique generation ID. Quarantine failed or partial transfers and preserve the
  previous verified copy. Record verification time and destination evidence.
- Monitor the age of the last independently verified replica, transfer and
  verification failures, storage capacity and custody recovery availability.
  Record local generation status and replica status independently. A same-host
  copy is useful for rehearsal. The destination acceptance must succeed with the
  origin unavailable and without reading the primary copy.

## Retention and expiry

| Proposed setting | Initial value for review |
| --- | --- |
| Capture cadence | Daily, with destination verification as part of the backup window. Alert when that window ends without a new verified replica. |
| Primary sealed generations | 7 days, subject to replica verification and holds. |
| Independent verified generations | 30 days, retaining at least two verified generations from different cuts with usable custody. |
| Deletion | Manual approval only. Automatic pruning and provider lifecycle for this bundle remain disabled until separately reviewed. |

Treat the complete generation, identity proof, trusted handoff record and key
dependencies as one retention unit. Before expiring it, record its age, evidence
of a newer independently verified and decryptable generation, retained generation
count, holds, and the operator's approval. Keep the last demonstrated restorable
generation until a replacement is demonstrated. Pause cleanup if transfer or
verification is failing, custody is unavailable, or an incident or investigation
requires a hold. Capacity pressure calls for review of storage or cadence, with
the recovery floor and holds intact.

The existing [Core logical/physical PITR policy](../PITR-PRODUCTION-PLAN.md)
documents its own targets, S3 Object Lock and lifecycle. Those settings cover
their configured recovery channels. The joint coordinator bundle needs its own
destination and approved policy. The proposed daily cadence and freshness alert
are planning inputs. The remote rehearsal must measure the effective RPO and RTO
before the owner approves recovery objectives.

## Evidence required before activation

1. Review the intended writer/role inventory, controller recovery procedure and
   capture coverage of the enrolled reports. Verify late calls and direct SQL
   are blocked after the planned cut.
2. Agree on a destination, independently recoverable key custody, capacity,
   cadence, retention, and named owners for recovery and expiry. Verify origin
   credentials cannot change or delete the replica or unwrap its key.
3. Run the [remote Windows preproduction rehearsal](COHERENT-BACKUP.md#remote-windows-vm-destination)
   from the independent replica with the origin unavailable. Test wrong-key or
   corrupt input, verify clean rollback/cleanup, and restore both databases with
   their report/receipt identities. Confirm recovery makes zero new agent calls.
   Measure RPO from the coherent cut to the declared outage, and RTO from outage
   to verified usable recovery. Record workload, destination and measured values.
4. Review the evidence and obtain a separate activation decision before changing
   production identities, scheduling or worker state.

Local evidence includes [custody separation](../acceptance/custody/2026-11-10/README.md),
[both databases restored under a separate account](../acceptance/custody/2026-11-10-local-restore/README.md)
and [the VM launcher rehearsal](../acceptance/custody/2026-11-11-vm-restore/README.md).
These runs used one physical host. The remote run and remote RPO/RTO are pending.
