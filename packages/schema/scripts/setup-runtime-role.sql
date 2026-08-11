\set ON_ERROR_STOP on

\echo Configuring the dedicated FORGE runtime role...

SELECT 'CREATE ROLE forge_test_runner LOGIN'
 WHERE NOT EXISTS (
     SELECT 1
       FROM pg_roles
      WHERE rolname = 'forge_test_runner'
 )
\gexec

SELECT format('REVOKE %I FROM forge_test_runner', granted_role.rolname)
  FROM pg_auth_members membership
  JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
  JOIN pg_roles member_role ON member_role.oid = membership.member
 WHERE member_role.rolname = 'forge_test_runner'
\gexec

ALTER ROLE forge_test_runner
    WITH LOGIN
         NOSUPERUSER
         NOCREATEDB
         NOCREATEROLE
         NOREPLICATION
         NOBYPASSRLS
         INHERIT
         CONNECTION LIMIT 20;

ALTER ROLE forge_test_runner SET statement_timeout = '15s';
ALTER ROLE forge_test_runner SET lock_timeout = '5s';
ALTER ROLE forge_test_runner SET idle_in_transaction_session_timeout = '30s';

\echo Choose a new password for forge_test_runner.
\password forge_test_runner

REVOKE ALL PRIVILEGES ON DATABASE :"DBNAME" FROM forge_test_runner;
GRANT CONNECT ON DATABASE :"DBNAME" TO forge_test_runner;

REVOKE ALL PRIVILEGES ON SCHEMA forge FROM forge_test_runner;
GRANT USAGE ON SCHEMA forge TO forge_test_runner;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA forge FROM forge_test_runner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA forge FROM forge_test_runner;

GRANT SELECT ON
    forge.schema_migrations,
    forge.projects,
    forge.agents,
    forge.project_agents,
    forge.tasks,
    forge.decisions,
    forge.memories,
    forge.memory_provenance,
    forge.documents,
    forge.document_chunks,
    forge.embedding_profiles,
    forge.embeddings,
    forge.executions,
    forge.context_packages,
    forge.context_package_items,
    forge.events,
    forge.audit_log,
    forge.idempotency_keys
TO forge_test_runner;

GRANT INSERT ON
    forge.projects,
    forge.agents,
    forge.project_agents,
    forge.tasks,
    forge.decisions,
    forge.memories,
    forge.memory_provenance,
    forge.embedding_profiles,
    forge.embeddings,
    forge.executions,
    forge.context_packages,
    forge.context_package_items,
    forge.events,
    forge.audit_log,
    forge.idempotency_keys
TO forge_test_runner;

GRANT UPDATE ON
    forge.tasks,
    forge.executions,
    forge.idempotency_keys
TO forge_test_runner;

\echo Runtime role configured.
