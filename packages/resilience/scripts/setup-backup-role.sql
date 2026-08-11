\set ON_ERROR_STOP on

\if :{?backup_role}
\else
  \set backup_role forge_backup_reader
\endif

SELECT format('CREATE ROLE %I LOGIN', :'backup_role')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'backup_role')
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 2',
  :'backup_role'
)
\gexec

SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'backup_role', '0')
\gexec
SELECT format('ALTER ROLE %I SET lock_timeout = %L', :'backup_role', '15s')
\gexec
SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', :'backup_role', '5min')
\gexec

\echo Choose a password for the dedicated backup reader.
\password :backup_role

SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), :'backup_role')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'backup_role')
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA forge FROM %I', :'backup_role')
\gexec
SELECT format('GRANT USAGE ON SCHEMA forge TO %I', :'backup_role')
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA forge FROM %I', :'backup_role')
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA forge FROM %I', :'backup_role')
\gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA forge TO %I', :'backup_role')
\gexec
SELECT format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA forge TO %I', :'backup_role')
\gexec

\echo Dedicated FORGE backup reader configured.
