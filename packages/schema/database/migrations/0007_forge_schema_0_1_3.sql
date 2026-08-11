-- FORGE PostgreSQL Schema 0.1.3
-- Immutable embeddings are keyed by the versioned source snapshot they represent.

ALTER TABLE forge.embeddings
ADD COLUMN source_version bigint;

-- Gateway 0.1.3 persisted the version in metadata. Older direct inserts are
-- conservatively associated with the source version that exists at migration time.
UPDATE forge.embeddings AS embedding
   SET source_version = COALESCE(
       CASE
         WHEN (embedding.metadata ->> 'forge_source_version') ~ '^[0-9]+$'
          AND length(embedding.metadata ->> 'forge_source_version') <= 19
          AND (embedding.metadata ->> 'forge_source_version')::numeric
              BETWEEN 1 AND 9223372036854775807
           THEN (embedding.metadata ->> 'forge_source_version')::bigint
       END,
       (SELECT memory.version
          FROM forge.memories AS memory
         WHERE memory.id = embedding.memory_id
           AND memory.project_id = embedding.project_id),
       (SELECT decision.version
          FROM forge.decisions AS decision
         WHERE decision.id = embedding.decision_id
           AND decision.project_id = embedding.project_id),
       (SELECT chunk.version
          FROM forge.document_chunks AS chunk
         WHERE chunk.id = embedding.document_chunk_id
           AND chunk.project_id = embedding.project_id)
   );

ALTER TABLE forge.embeddings
ALTER COLUMN source_version SET NOT NULL;

ALTER TABLE forge.embeddings
ADD CONSTRAINT embeddings_source_version_positive CHECK (source_version > 0);

DROP INDEX forge.uq_embeddings_profile_memory;
DROP INDEX forge.uq_embeddings_profile_decision;
DROP INDEX forge.uq_embeddings_profile_chunk;

CREATE UNIQUE INDEX uq_embeddings_profile_memory
    ON forge.embeddings(profile_id, memory_id, source_version)
    WHERE memory_id IS NOT NULL;

CREATE UNIQUE INDEX uq_embeddings_profile_decision
    ON forge.embeddings(profile_id, decision_id, source_version)
    WHERE decision_id IS NOT NULL;

CREATE UNIQUE INDEX uq_embeddings_profile_chunk
    ON forge.embeddings(profile_id, document_chunk_id, source_version)
    WHERE document_chunk_id IS NOT NULL;

CREATE OR REPLACE FUNCTION forge.validate_embedding_source_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    current_source_version bigint;
BEGIN
    IF NEW.memory_id IS NOT NULL THEN
        SELECT memory.version
          INTO current_source_version
          FROM forge.memories AS memory
         WHERE memory.id = NEW.memory_id
           AND memory.project_id = NEW.project_id
           AND memory.deleted_at IS NULL
           AND memory.status = 'active'
           FOR SHARE;
    ELSIF NEW.decision_id IS NOT NULL THEN
        SELECT decision.version
          INTO current_source_version
          FROM forge.decisions AS decision
         WHERE decision.id = NEW.decision_id
           AND decision.project_id = NEW.project_id
           AND decision.status IN ('draft', 'accepted')
           FOR SHARE;
    ELSIF NEW.document_chunk_id IS NOT NULL THEN
        SELECT chunk.version
          INTO current_source_version
          FROM forge.document_chunks AS chunk
          JOIN forge.documents AS document
            ON document.id = chunk.document_id
           AND document.project_id = chunk.project_id
         WHERE chunk.id = NEW.document_chunk_id
           AND chunk.project_id = NEW.project_id
           AND chunk.deleted_at IS NULL
           AND document.deleted_at IS NULL
           FOR SHARE OF chunk, document;
    END IF;

    IF current_source_version IS NULL THEN
        RAISE EXCEPTION 'Active embedding source does not exist in project %', NEW.project_id
            USING ERRCODE = '23503';
    END IF;

    IF NEW.source_version <> current_source_version THEN
        RAISE EXCEPTION 'Embedding source version mismatch: expected %, got %',
            current_source_version, NEW.source_version
            USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION forge.validate_embedding_source_version() FROM PUBLIC;

CREATE TRIGGER embeddings_validate_source_version
BEFORE INSERT OR UPDATE OF project_id, memory_id, decision_id, document_chunk_id, source_version
ON forge.embeddings
FOR EACH ROW EXECUTE FUNCTION forge.validate_embedding_source_version();

CREATE TRIGGER embeddings_append_only
BEFORE UPDATE OR DELETE ON forge.embeddings
FOR EACH ROW EXECUTE FUNCTION forge.prevent_mutation();
