-- FORGE PostgreSQL Schema 0.1.2
-- Allow least-privilege embedding inserts without granting profile UPDATE.

CREATE OR REPLACE FUNCTION forge.validate_embedding_dimensions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    expected_dimensions integer;
    actual_dimensions integer;
BEGIN
    -- The definer-owned row lock serializes inserts with profile dimension changes.
    SELECT dimensions
      INTO expected_dimensions
      FROM forge.embedding_profiles
     WHERE id = NEW.profile_id
       FOR SHARE;

    IF expected_dimensions IS NULL THEN
        RAISE EXCEPTION 'Embedding profile % does not exist', NEW.profile_id
            USING ERRCODE = '23503';
    END IF;

    actual_dimensions := public.vector_dims(NEW.embedding);
    IF actual_dimensions <> expected_dimensions THEN
        RAISE EXCEPTION 'Embedding dimension mismatch: expected %, got %',
            expected_dimensions, actual_dimensions
            USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION forge.validate_embedding_dimensions() FROM PUBLIC;
