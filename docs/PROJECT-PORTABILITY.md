# Project portability

FORGE Workbench can onboard an existing repository or move a FORGE project
between installations. Both flows are local, project-scoped and transactional.

## Onboard an existing repository

1. Open **Importar proyecto**.
2. Select **Carpeta existente** and choose the repository root.
3. Review the detected project key, name and number of accepted files.
4. Import. FORGE reads the selected files but never changes the repository.

The onboarding allowlist includes root project documentation, common manifests
and text documentation below `docs`, `doc`, `documentation`, `adr`,
`architecture` or `decisions`. Source code, generated/vendor directories,
environment files, credentials, private keys and likely secret paths are
excluded. At most 64 files, 32,000 characters per file and 1,000,000 characters
in total are accepted.

Path filtering reduces accidental exposure; it cannot detect a secret written
inside an otherwise valid README or memory. Review selected content and protect
portable packages with the same care as the source project.

Accepted files become project memories with their relative path, content hash
and document provenance. This creates useful initial context without pretending
that inferred tasks or decisions already exist.

## Export and import a FORGE project

Select a project and use **Exportar**. Workbench downloads a
`<project-key>.forge-project` JSON package with a canonical SHA-256 checksum.
The package contains:

- project identity and metadata;
- active assigned agents;
- tasks and stable agent references;
- memories and provenance;
- decisions and supersession references.

It deliberately omits embeddings, executions, immutable continuation packages,
events and audit rows. Embeddings are provider/profile-specific and are rebuilt
at the destination. Operational history remains available through FORGE backup
and recovery, not through portable replay.

When importing a package, use **Create new project** for a new key. Use **Merge
without overwrite** only when adding missing records to an existing project.
Merge rejects incompatible stable-key collisions and rolls the entire import
back; it never silently overwrites the destination.

## Security properties

- Package checksum is verified before database writes.
- Version 1 refuses to create or accept packages larger than 4 MiB.
- Import is one PostgreSQL transaction.
- Request replay is idempotent.
- References are rebuilt from stable keys and remain project-scoped.
- Package endpoints retain loopback token and same-origin protection.
- Portable JSON is limited to 4 MiB; ordinary Workbench JSON remains 64 KiB.

Project portability complements, but does not replace, encrypted logical
recovery and PITR.
