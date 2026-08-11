\set ON_ERROR_STOP on

\echo Applying least-privilege FORGE vector grants...

REVOKE ALL PRIVILEGES ON
    forge.documents,
    forge.document_chunks,
    forge.embedding_profiles,
    forge.embeddings
FROM forge_test_runner;

GRANT SELECT ON
    forge.documents,
    forge.document_chunks,
    forge.embedding_profiles,
    forge.embeddings
TO forge_test_runner;

GRANT INSERT ON
    forge.embedding_profiles,
    forge.embeddings
TO forge_test_runner;

\echo FORGE vector runtime grants applied.
