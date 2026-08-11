-- FORGE PostgreSQL Schema 0.1.1
-- Implementation-review corrections SQL-02, SQL-06, SQL-07 and SQL-08.

-- SQL-08: duplicate forge_id values must be representable while unresolved.
ALTER TABLE forge.documents
DROP CONSTRAINT IF EXISTS documents_forge_id_key;

CREATE UNIQUE INDEX uq_documents_managed_forge_id
ON forge.documents(forge_id)
WHERE management_state = 'managed' AND forge_id IS NOT NULL;

-- SQL-02: a canonical identity cannot change while a document is managed.
CREATE OR REPLACE FUNCTION forge.protect_managed_forge_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.management_state = 'managed'
       AND OLD.forge_id IS NOT NULL
       AND NEW.forge_id IS DISTINCT FROM OLD.forge_id
    THEN
        RAISE EXCEPTION 'forge_id is immutable for managed documents'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER documents_protect_managed_forge_id
BEFORE UPDATE OF forge_id, management_state ON forge.documents
FOR EACH ROW EXECUTE FUNCTION forge.protect_managed_forge_id();

-- SQL-06: all scoped relationships carry the project boundary in the FK.
ALTER TABLE forge.executions
ADD CONSTRAINT uq_executions_id_project UNIQUE (id, project_id);

ALTER TABLE forge.context_packages
ADD CONSTRAINT uq_context_packages_id_project UNIQUE (id, project_id);

ALTER TABLE forge.context_packages
DROP CONSTRAINT IF EXISTS context_packages_execution_id_fkey;

ALTER TABLE forge.context_packages
ADD CONSTRAINT fk_context_packages_execution_project
FOREIGN KEY (execution_id, project_id)
REFERENCES forge.executions(id, project_id)
ON DELETE RESTRICT;

ALTER TABLE forge.context_package_items
DROP CONSTRAINT IF EXISTS context_package_items_context_package_id_fkey;

ALTER TABLE forge.context_package_items
ADD CONSTRAINT fk_context_package_items_package_project
FOREIGN KEY (context_package_id, project_id)
REFERENCES forge.context_packages(id, project_id)
ON DELETE RESTRICT;

ALTER TABLE forge.events
DROP CONSTRAINT IF EXISTS events_execution_id_fkey;

ALTER TABLE forge.events
ADD CONSTRAINT fk_events_execution_project
FOREIGN KEY (execution_id, project_id)
REFERENCES forge.executions(id, project_id)
ON DELETE RESTRICT;

ALTER TABLE forge.events
ADD CONSTRAINT ck_events_execution_requires_project
CHECK (execution_id IS NULL OR project_id IS NOT NULL);

ALTER TABLE forge.events
ADD CONSTRAINT fk_events_project_agent
FOREIGN KEY (project_id, agent_id)
REFERENCES forge.project_agents(project_id, agent_id)
ON DELETE RESTRICT;

ALTER TABLE forge.events
ADD CONSTRAINT ck_events_agent_requires_project
CHECK (agent_id IS NULL OR project_id IS NOT NULL);

ALTER TABLE forge.audit_log
DROP CONSTRAINT IF EXISTS audit_log_execution_id_fkey;

ALTER TABLE forge.audit_log
ADD CONSTRAINT fk_audit_execution_project
FOREIGN KEY (execution_id, project_id)
REFERENCES forge.executions(id, project_id)
ON DELETE RESTRICT;

ALTER TABLE forge.audit_log
ADD CONSTRAINT ck_audit_execution_requires_project
CHECK (execution_id IS NULL OR project_id IS NOT NULL);

ALTER TABLE forge.audit_log
DROP CONSTRAINT IF EXISTS audit_log_context_package_id_fkey;

ALTER TABLE forge.audit_log
ADD CONSTRAINT fk_audit_context_project
FOREIGN KEY (context_package_id, project_id)
REFERENCES forge.context_packages(id, project_id)
ON DELETE RESTRICT;

ALTER TABLE forge.audit_log
ADD CONSTRAINT ck_audit_context_requires_project
CHECK (context_package_id IS NULL OR project_id IS NOT NULL);

ALTER TABLE forge.audit_log
ADD CONSTRAINT fk_audit_project_agent
FOREIGN KEY (project_id, agent_id)
REFERENCES forge.project_agents(project_id, agent_id)
ON DELETE RESTRICT;

ALTER TABLE forge.audit_log
ADD CONSTRAINT ck_audit_agent_requires_project
CHECK (agent_id IS NULL OR project_id IS NOT NULL);

-- SQL-07: embedding vectors must match their profile's vector-space contract.
CREATE OR REPLACE FUNCTION forge.validate_embedding_dimensions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected_dimensions integer;
    actual_dimensions integer;
BEGIN
    -- FOR SHARE serializes this validation with profile dimension changes.
    SELECT dimensions
      INTO expected_dimensions
      FROM forge.embedding_profiles
     WHERE id = NEW.profile_id
       FOR SHARE;

    IF expected_dimensions IS NULL THEN
        RAISE EXCEPTION 'Embedding profile % does not exist', NEW.profile_id
            USING ERRCODE = '23503';
    END IF;

    actual_dimensions := vector_dims(NEW.embedding);
    IF actual_dimensions <> expected_dimensions THEN
        RAISE EXCEPTION 'Embedding dimension mismatch: expected %, got %',
            expected_dimensions, actual_dimensions
            USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER embeddings_validate_dimensions
BEFORE INSERT OR UPDATE OF embedding, profile_id ON forge.embeddings
FOR EACH ROW EXECUTE FUNCTION forge.validate_embedding_dimensions();

CREATE OR REPLACE FUNCTION forge.protect_embedding_profile_dimensions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.dimensions IS DISTINCT FROM OLD.dimensions
       AND EXISTS (
           SELECT 1
             FROM forge.embeddings
            WHERE profile_id = OLD.id
            LIMIT 1
       )
    THEN
        RAISE EXCEPTION 'Cannot change dimensions of embedding profile with existing embeddings'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER embedding_profiles_protect_dimensions
BEFORE UPDATE OF dimensions ON forge.embedding_profiles
FOR EACH ROW EXECUTE FUNCTION forge.protect_embedding_profile_dimensions();
