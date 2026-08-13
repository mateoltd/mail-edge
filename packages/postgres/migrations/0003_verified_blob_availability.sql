-- Enforce that every available raw blob is the exact output of a verified promotion stage.

CREATE FUNCTION mail_edge_require_verified_blob_availability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_stage blob_ingest_stages%ROWTYPE;
BEGIN
  IF NEW.status <> 'available' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO source_stage
  FROM blob_ingest_stages
  WHERE tenant_id = NEW.tenant_id
    AND stage_id = NEW.source_stage_id;

  IF source_stage.stage_id IS NULL
    OR source_stage.state NOT IN ('promoting', 'promoted')
    OR source_stage.observed_bytes IS NULL
    OR source_stage.observed_sha256 IS NULL
    OR source_stage.observed_bytes > source_stage.expected_max_bytes
    OR source_stage.final_object_key IS DISTINCT FROM NEW.object_key
    OR source_stage.final_object_version IS DISTINCT FROM NEW.object_version
    OR source_stage.observed_bytes IS DISTINCT FROM NEW.size_bytes
    OR source_stage.observed_sha256 IS DISTINCT FROM NEW.sha256
    OR source_stage.encryption_key_ref IS DISTINCT FROM NEW.kms_key_ref
    OR source_stage.wrapped_dek IS DISTINCT FROM NEW.wrapped_dek
    OR source_stage.encryption_metadata IS DISTINCT FROM NEW.encryption_metadata
    OR source_stage.encryption_metadata ->> 'purpose' IS DISTINCT FROM source_stage.purpose
    OR source_stage.encryption_metadata -> 'formatVersion'
       IS DISTINCT FROM to_jsonb(NEW.encryption_format_version)
  THEN
    RAISE EXCEPTION 'available raw blob is not backed by its exact verified promotion stage'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER raw_blobs_verified_availability
  BEFORE INSERT OR UPDATE ON raw_blobs
  FOR EACH ROW EXECUTE FUNCTION mail_edge_require_verified_blob_availability();
