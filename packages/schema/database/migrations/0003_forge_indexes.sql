-- FORGE PostgreSQL Schema 0.1 - query and idempotency indexes

CREATE INDEX idx_tasks_project_status
    ON forge.tasks(project_id, status) WHERE deleted_at IS NULL;

CREATE INDEX idx_decisions_project_status
    ON forge.decisions(project_id, status);

CREATE INDEX idx_memories_project_active
    ON forge.memories(project_id, memory_type, importance)
    WHERE deleted_at IS NULL AND status = 'active';

CREATE INDEX idx_documents_project_state
    ON forge.documents(project_id, management_state)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_document_chunks_document
    ON forge.document_chunks(document_id, chunk_index)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_executions_project_status
    ON forge.executions(project_id, status, created_at DESC);

CREATE INDEX idx_context_packages_execution
    ON forge.context_packages(execution_id)
    WHERE execution_id IS NOT NULL;

CREATE INDEX idx_events_project_time
    ON forge.events(project_id, occurred_at DESC);

CREATE INDEX idx_audit_project_time
    ON forge.audit_log(project_id, recorded_at DESC);

CREATE UNIQUE INDEX uq_events_project_idempotency
    ON forge.events(project_id, idempotency_key)
    WHERE project_id IS NOT NULL AND idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX uq_events_global_idempotency
    ON forge.events(idempotency_key)
    WHERE project_id IS NULL AND idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX uq_embeddings_profile_memory
    ON forge.embeddings(profile_id, memory_id)
    WHERE memory_id IS NOT NULL;

CREATE UNIQUE INDEX uq_embeddings_profile_decision
    ON forge.embeddings(profile_id, decision_id)
    WHERE decision_id IS NOT NULL;

CREATE UNIQUE INDEX uq_embeddings_profile_chunk
    ON forge.embeddings(profile_id, document_chunk_id)
    WHERE document_chunk_id IS NOT NULL;
