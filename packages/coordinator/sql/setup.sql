-- Run as the dedicated coordinator-state owner in its own schema/database.
-- This does not modify forge.*, its migrations or the Core runtime grants.
-- Provision forge_coordinator with AUTHORIZATION to that owner first.
CREATE TABLE IF NOT EXISTS forge_coordinator.jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    task_key text NOT NULL CHECK (length(task_key) BETWEEN 1 AND 200),
    agent_id uuid NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed')),
    owner text,
    epoch integer NOT NULL DEFAULT 0,
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
    lease_until timestamptz,
    artifact jsonb,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (project_id, task_id)
);
CREATE INDEX IF NOT EXISTS jobs_dispatch ON forge_coordinator.jobs(agent_id, created_at, id)
    WHERE state IN ('queued', 'running');
