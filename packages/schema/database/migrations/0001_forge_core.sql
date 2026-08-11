-- FORGE PostgreSQL Schema 0.1 - relational core
-- PostgreSQL 14+

CREATE SCHEMA IF NOT EXISTS forge;

CREATE OR REPLACE FUNCTION forge.bump_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.version := OLD.version + 1;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION forge.prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$$;

CREATE TABLE forge.projects (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_key     text NOT NULL UNIQUE,
    name            text NOT NULL,
    description     text,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'archived')),
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(metadata) = 'object'),
    version         bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz,
    CHECK (length(trim(project_key)) > 0),
    CHECK (length(trim(name)) > 0)
);

CREATE TABLE forge.agents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_key       text NOT NULL UNIQUE,
    name            text NOT NULL,
    role            text,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'disabled', 'retired', 'quarantined')),
    capabilities    jsonb NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(capabilities) = 'object'),
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(metadata) = 'object'),
    version         bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    retired_at      timestamptz,
    CHECK (length(trim(agent_key)) > 0),
    CHECK (length(trim(name)) > 0)
);

CREATE TABLE forge.project_agents (
    project_id      uuid NOT NULL REFERENCES forge.projects(id) ON DELETE RESTRICT,
    agent_id        uuid NOT NULL REFERENCES forge.agents(id) ON DELETE RESTRICT,
    assignment_role text,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive')),
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(metadata) = 'object'),
    version         bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    assigned_at     timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz,
    PRIMARY KEY (project_id, agent_id)
);

CREATE TABLE forge.tasks (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid NOT NULL REFERENCES forge.projects(id) ON DELETE RESTRICT,
    parent_task_id      uuid,
    assigned_agent_id   uuid,
    task_key            text NOT NULL,
    title               text NOT NULL,
    objective           text,
    status              text NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed', 'ready', 'in_progress', 'blocked', 'done', 'cancelled')),
    priority            text NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(metadata) = 'object'),
    version             bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz,
    deleted_at          timestamptz,
    UNIQUE (project_id, task_key),
    UNIQUE (id, project_id),
    FOREIGN KEY (parent_task_id, project_id)
        REFERENCES forge.tasks(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, assigned_agent_id)
        REFERENCES forge.project_agents(project_id, agent_id) ON DELETE RESTRICT,
    CHECK (length(trim(task_key)) > 0),
    CHECK (length(trim(title)) > 0),
    CHECK (parent_task_id IS NULL OR parent_task_id <> id)
);

CREATE TABLE forge.decisions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid NOT NULL REFERENCES forge.projects(id) ON DELETE RESTRICT,
    task_id             uuid,
    created_by_agent_id uuid,
    decision_key        text NOT NULL,
    title               text NOT NULL,
    decision_text       text NOT NULL,
    rationale           text,
    alternatives        jsonb NOT NULL DEFAULT '[]'::jsonb
                        CHECK (jsonb_typeof(alternatives) = 'array'),
    consequences        jsonb NOT NULL DEFAULT '[]'::jsonb
                        CHECK (jsonb_typeof(consequences) = 'array'),
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'accepted', 'rejected', 'superseded', 'deprecated')),
    supersedes_id       uuid,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(metadata) = 'object'),
    version             bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, decision_key),
    UNIQUE (id, project_id),
    FOREIGN KEY (task_id, project_id)
        REFERENCES forge.tasks(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, created_by_agent_id)
        REFERENCES forge.project_agents(project_id, agent_id) ON DELETE RESTRICT,
    FOREIGN KEY (supersedes_id, project_id)
        REFERENCES forge.decisions(id, project_id) ON DELETE RESTRICT,
    CHECK (length(trim(decision_key)) > 0),
    CHECK (length(trim(title)) > 0),
    CHECK (length(trim(decision_text)) > 0),
    CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

CREATE TABLE forge.memories (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid NOT NULL REFERENCES forge.projects(id) ON DELETE RESTRICT,
    task_id             uuid,
    created_by_agent_id uuid,
    memory_type         text NOT NULL
                        CHECK (memory_type IN ('episodic', 'semantic', 'project', 'observation', 'execution_summary')),
    epistemic_state     text NOT NULL DEFAULT 'observed'
                        CHECK (epistemic_state IN ('verified', 'supported', 'observed', 'inferred', 'hypothesis', 'conflicting', 'unknown', 'invalid')),
    trust_level         text NOT NULL DEFAULT 'internal'
                        CHECK (trust_level IN ('trusted', 'internal', 'agent_generated', 'external', 'untrusted')),
    status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'superseded', 'expired', 'invalid')),
    title               text,
    content             text NOT NULL,
    summary             text,
    importance          text NOT NULL DEFAULT 'normal'
                        CHECK (importance IN ('low', 'normal', 'high', 'critical')),
    superseded_by       uuid,
    expires_at          timestamptz,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(metadata) = 'object'),
    version             bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz,
    UNIQUE (id, project_id),
    FOREIGN KEY (task_id, project_id)
        REFERENCES forge.tasks(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, created_by_agent_id)
        REFERENCES forge.project_agents(project_id, agent_id) ON DELETE RESTRICT,
    FOREIGN KEY (superseded_by, project_id)
        REFERENCES forge.memories(id, project_id) ON DELETE RESTRICT,
    CHECK (length(trim(content)) > 0),
    CHECK (superseded_by IS NULL OR superseded_by <> id)
);

CREATE TABLE forge.memory_provenance (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id           uuid NOT NULL REFERENCES forge.memories(id) ON DELETE CASCADE,
    source_kind         text NOT NULL
                        CHECK (source_kind IN ('document', 'decision', 'execution', 'agent', 'user', 'tool', 'external')),
    source_ref          text NOT NULL,
    source_version      text,
    evidence            jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(evidence) = 'object'),
    recorded_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (length(trim(source_ref)) > 0)
);

CREATE TABLE forge.documents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid NOT NULL REFERENCES forge.projects(id) ON DELETE RESTRICT,
    forge_id            uuid UNIQUE,
    source_kind         text NOT NULL DEFAULT 'file'
                        CHECK (source_kind IN ('file', 'note', 'generated', 'external')),
    management_state    text NOT NULL DEFAULT 'unmanaged'
                        CHECK (management_state IN ('unmanaged', 'conflict', 'managed')),
    current_path        text,
    title               text,
    content_hash        text,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(metadata) = 'object'),
    version             bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz,
    UNIQUE (id, project_id),
    CHECK (management_state <> 'managed' OR forge_id IS NOT NULL),
    CHECK (current_path IS NULL OR length(trim(current_path)) > 0)
);

CREATE TABLE forge.document_paths (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id         uuid NOT NULL,
    project_id          uuid NOT NULL,
    path                text NOT NULL,
    observed_at         timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (document_id, project_id)
        REFERENCES forge.documents(id, project_id) ON DELETE RESTRICT,
    CHECK (length(trim(path)) > 0)
);

CREATE TABLE forge.document_chunks (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid NOT NULL REFERENCES forge.projects(id) ON DELETE RESTRICT,
    document_id         uuid NOT NULL,
    chunk_index         integer NOT NULL CHECK (chunk_index >= 0),
    content             text NOT NULL,
    content_hash        text,
    token_count         integer CHECK (token_count IS NULL OR token_count >= 0),
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(metadata) = 'object'),
    version             bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz,
    UNIQUE (id, project_id),
    UNIQUE (document_id, chunk_index),
    FOREIGN KEY (document_id, project_id)
        REFERENCES forge.documents(id, project_id) ON DELETE RESTRICT,
    CHECK (length(trim(content)) > 0)
);

CREATE TABLE forge.context_contracts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid NOT NULL REFERENCES forge.projects(id) ON DELETE RESTRICT,
    contract_key        text NOT NULL,
    name                text NOT NULL,
    contract            jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(contract) = 'object'),
    status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'inactive', 'superseded')),
    version             bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, contract_key),
    UNIQUE (id, project_id),
    CHECK (length(trim(contract_key)) > 0),
    CHECK (length(trim(name)) > 0)
);

CREATE TABLE forge.executions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid NOT NULL REFERENCES forge.projects(id) ON DELETE RESTRICT,
    task_id             uuid,
    agent_id            uuid,
    context_contract_id uuid,
    execution_key       text,
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
    policy_version      text,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(metadata) = 'object'),
    version             bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    started_at          timestamptz,
    completed_at        timestamptz,
    UNIQUE (project_id, execution_key),
    FOREIGN KEY (task_id, project_id)
        REFERENCES forge.tasks(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, agent_id)
        REFERENCES forge.project_agents(project_id, agent_id) ON DELETE RESTRICT,
    FOREIGN KEY (context_contract_id, project_id)
        REFERENCES forge.context_contracts(id, project_id) ON DELETE RESTRICT,
    CHECK (execution_key IS NULL OR length(trim(execution_key)) > 0)
);

CREATE TABLE forge.context_packages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid NOT NULL REFERENCES forge.projects(id) ON DELETE RESTRICT,
    execution_id        uuid REFERENCES forge.executions(id) ON DELETE RESTRICT,
    context_contract_id uuid,
    package_hash        text NOT NULL,
    token_count         integer CHECK (token_count IS NULL OR token_count >= 0),
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at          timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (context_contract_id, project_id)
        REFERENCES forge.context_contracts(id, project_id) ON DELETE RESTRICT,
    CHECK (length(trim(package_hash)) > 0)
);

CREATE TABLE forge.context_package_items (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    context_package_id  uuid NOT NULL REFERENCES forge.context_packages(id) ON DELETE RESTRICT,
    project_id          uuid NOT NULL REFERENCES forge.projects(id) ON DELETE RESTRICT,
    position            integer NOT NULL CHECK (position >= 0),
    source_kind         text NOT NULL,
    source_ref          text NOT NULL,
    source_version      text,
    content_hash        text NOT NULL,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (context_package_id, position),
    CHECK (length(trim(source_kind)) > 0),
    CHECK (length(trim(source_ref)) > 0),
    CHECK (length(trim(content_hash)) > 0)
);

CREATE TABLE forge.events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid REFERENCES forge.projects(id) ON DELETE RESTRICT,
    execution_id        uuid REFERENCES forge.executions(id) ON DELETE RESTRICT,
    agent_id            uuid,
    event_type          text NOT NULL,
    idempotency_key     text,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(payload) = 'object'),
    occurred_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (length(trim(event_type)) > 0),
    CHECK (idempotency_key IS NULL OR length(trim(idempotency_key)) > 0)
);

CREATE TABLE forge.audit_log (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid REFERENCES forge.projects(id) ON DELETE RESTRICT,
    execution_id        uuid REFERENCES forge.executions(id) ON DELETE RESTRICT,
    context_package_id  uuid REFERENCES forge.context_packages(id) ON DELETE RESTRICT,
    agent_id            uuid,
    action              text NOT NULL,
    authorization_decision text NOT NULL
                        CHECK (authorization_decision IN ('allowed', 'denied', 'not_applicable')),
    policy_version      text,
    resource            text,
    details             jsonb NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(details) = 'object'),
    recorded_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (length(trim(action)) > 0)
);

CREATE TABLE forge.idempotency_keys (
    project_id          uuid NOT NULL REFERENCES forge.projects(id) ON DELETE RESTRICT,
    scope               text NOT NULL,
    idempotency_key     text NOT NULL,
    request_hash        text NOT NULL,
    status              text NOT NULL DEFAULT 'in_progress'
                        CHECK (status IN ('in_progress', 'completed', 'failed')),
    response            jsonb,
    version             bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz,
    PRIMARY KEY (project_id, scope, idempotency_key),
    CHECK (length(trim(scope)) > 0),
    CHECK (length(trim(idempotency_key)) > 0),
    CHECK (length(trim(request_hash)) > 0),
    CHECK (response IS NULL OR jsonb_typeof(response) IN ('object', 'array', 'string', 'number', 'boolean', 'null'))
);
