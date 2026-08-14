# Privacy policy

FORGE does not collect analytics, telemetry, advertising identifiers or crash
reports, and it does not operate a hosted user-data service.

The software will not transfer information to another networked system unless
the user or operator explicitly configures or requests that operation.

## Configured connections

- PostgreSQL stores project data at the database endpoint selected by the
  operator. The default product does not relay that data through ProjForge.
- Semantic search contacts only the embedding or reranking endpoint configured
  by the operator. The recommended LM Studio setup runs on loopback.
- Recovery contacts an S3-compatible endpoint only when the operator enables
  and configures that target.
- GitHub and SignPath are used by maintainers to publish source, release
  artifacts and signatures; the installed Workbench does not report usage to
  either service.

An operator who chooses a remote database, model provider or object-storage
provider is responsible for that provider's privacy terms and data location.

## Local data and credentials

Workbench binds to loopback and keeps PostgreSQL credentials outside browser
state. On Windows, the runtime password is stored using CurrentUser DPAPI and
can only be decrypted by the same Windows user on the same machine. Logs,
health responses and release evidence are designed to exclude credentials and
deployment-specific filesystem paths.

Uninstalling Workbench preserves configuration and durable database data by
default. The documented `-PurgeUserData` option removes the per-user Workbench
configuration and encrypted credential when explicitly requested.

Security issues should be reported through [SECURITY.md](SECURITY.md), not a
public issue containing private data or credentials.
