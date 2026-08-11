-- FORGE PostgreSQL Schema 0.1 - mutation guards and version maintenance

CREATE OR REPLACE FUNCTION forge.track_document_path()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.current_path IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.current_path IS DISTINCT FROM OLD.current_path)
    THEN
        INSERT INTO forge.document_paths(document_id, project_id, path)
        VALUES (NEW.id, NEW.project_id, NEW.current_path);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER projects_bump_version
BEFORE UPDATE ON forge.projects
FOR EACH ROW EXECUTE FUNCTION forge.bump_version();

CREATE TRIGGER agents_bump_version
BEFORE UPDATE ON forge.agents
FOR EACH ROW EXECUTE FUNCTION forge.bump_version();

CREATE TRIGGER project_agents_bump_version
BEFORE UPDATE ON forge.project_agents
FOR EACH ROW EXECUTE FUNCTION forge.bump_version();

CREATE TRIGGER tasks_bump_version
BEFORE UPDATE ON forge.tasks
FOR EACH ROW EXECUTE FUNCTION forge.bump_version();

CREATE TRIGGER decisions_bump_version
BEFORE UPDATE ON forge.decisions
FOR EACH ROW EXECUTE FUNCTION forge.bump_version();

CREATE TRIGGER memories_bump_version
BEFORE UPDATE ON forge.memories
FOR EACH ROW EXECUTE FUNCTION forge.bump_version();

CREATE TRIGGER documents_bump_version
BEFORE UPDATE ON forge.documents
FOR EACH ROW EXECUTE FUNCTION forge.bump_version();

CREATE TRIGGER document_chunks_bump_version
BEFORE UPDATE ON forge.document_chunks
FOR EACH ROW EXECUTE FUNCTION forge.bump_version();

CREATE TRIGGER context_contracts_bump_version
BEFORE UPDATE ON forge.context_contracts
FOR EACH ROW EXECUTE FUNCTION forge.bump_version();

CREATE TRIGGER executions_bump_version
BEFORE UPDATE ON forge.executions
FOR EACH ROW EXECUTE FUNCTION forge.bump_version();

CREATE TRIGGER idempotency_keys_bump_version
BEFORE UPDATE ON forge.idempotency_keys
FOR EACH ROW EXECUTE FUNCTION forge.bump_version();

CREATE TRIGGER embedding_profiles_bump_version
BEFORE UPDATE ON forge.embedding_profiles
FOR EACH ROW EXECUTE FUNCTION forge.bump_version();

CREATE TRIGGER documents_track_path
AFTER INSERT OR UPDATE OF current_path ON forge.documents
FOR EACH ROW EXECUTE FUNCTION forge.track_document_path();

CREATE TRIGGER context_packages_append_only
BEFORE UPDATE OR DELETE ON forge.context_packages
FOR EACH ROW EXECUTE FUNCTION forge.prevent_mutation();

CREATE TRIGGER context_package_items_append_only
BEFORE UPDATE OR DELETE ON forge.context_package_items
FOR EACH ROW EXECUTE FUNCTION forge.prevent_mutation();

CREATE TRIGGER events_append_only
BEFORE UPDATE OR DELETE ON forge.events
FOR EACH ROW EXECUTE FUNCTION forge.prevent_mutation();

CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON forge.audit_log
FOR EACH ROW EXECUTE FUNCTION forge.prevent_mutation();

CREATE TRIGGER document_paths_append_only
BEFORE UPDATE OR DELETE ON forge.document_paths
FOR EACH ROW EXECUTE FUNCTION forge.prevent_mutation();
