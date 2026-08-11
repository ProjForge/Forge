-- FORGE PostgreSQL Schema 0.1 - optional vector layer
-- This is the only migration that requires pgvector.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE forge.embedding_profiles (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_key         text NOT NULL UNIQUE,
    provider            text NOT NULL,
    model               text NOT NULL,
    dimensions          integer NOT NULL CHECK (dimensions > 0),
    distance_metric     text NOT NULL DEFAULT 'cosine'
                        CHECK (distance_metric IN ('cosine', 'l2', 'inner_product')),
    status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'inactive')),
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(metadata) = 'object'),
    version             bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (length(trim(profile_key)) > 0),
    CHECK (length(trim(provider)) > 0),
    CHECK (length(trim(model)) > 0)
);

CREATE TABLE forge.embeddings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid NOT NULL REFERENCES forge.projects(id) ON DELETE RESTRICT,
    profile_id          uuid NOT NULL REFERENCES forge.embedding_profiles(id) ON DELETE RESTRICT,
    memory_id           uuid,
    decision_id         uuid,
    document_chunk_id   uuid,
    embedding           vector NOT NULL,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at          timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (memory_id, project_id)
        REFERENCES forge.memories(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (decision_id, project_id)
        REFERENCES forge.decisions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (document_chunk_id, project_id)
        REFERENCES forge.document_chunks(id, project_id) ON DELETE RESTRICT,
    CHECK (num_nonnulls(memory_id, decision_id, document_chunk_id) = 1)
);
