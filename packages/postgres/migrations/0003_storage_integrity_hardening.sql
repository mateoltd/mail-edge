-- Storage-integrity, dispatch-fencing, and tenant-isolation hardening.

ALTER TABLE raw_blobs
  ADD COLUMN corruption_detected_at timestamptz,
  ADD COLUMN integrity_verified_at timestamptz;

UPDATE raw_blobs
SET corruption_detected_at = created_at
WHERE status = 'corrupt';

ALTER TABLE raw_blobs
  ADD CONSTRAINT raw_blobs_integrity_timestamps CHECK (
    (status = 'corrupt') = (corruption_detected_at IS NOT NULL)
    AND (integrity_verified_at IS NULL OR integrity_verified_at >= available_at)
  );

ALTER TABLE outbound_attempts
  ADD COLUMN route_snapshot jsonb;

UPDATE outbound_attempts AS attempt
SET route_snapshot = jsonb_build_object(
  'schemaVersion', 'v1',
  'tenantId', binding.tenant_id,
  'bindingId', binding.binding_id,
  'bindingVersion', binding.binding_version,
  'domainALabel', binding.domain_a_label,
  'direction', binding.direction,
  'providerId', binding.provider_id,
  'providerInstanceId', binding.provider_instance_id,
  'adapterVersion', binding.adapter_version,
  'configRevision', binding.config_revision,
  'capabilityDigest', encode(binding.capability_digest, 'hex'),
  'providerResourceIds', binding.provider_resource_ids,
  'createdAt', binding.created_at
)
FROM route_bindings AS binding
WHERE binding.tenant_id = attempt.tenant_id
  AND binding.binding_id = attempt.binding_id
  AND binding.binding_version = attempt.binding_version;

UPDATE outbound_attempts
SET state = 'quarantined_unknown',
    certainty = 'unknown',
    completed_at = coalesce(completed_at, clock_timestamp()),
    last_error_code = 'MISSING_DISPATCH_LEASE'
WHERE state = 'dispatching' AND claimed_until IS NULL;

UPDATE outbound_intents AS intent
SET state = 'quarantined_unknown',
    optimistic_version = optimistic_version + 1,
    next_action_at = NULL,
    updated_at = clock_timestamp()
FROM outbound_attempts AS attempt
WHERE attempt.tenant_id = intent.tenant_id
  AND attempt.intent_id = intent.intent_id
  AND attempt.attempt_id = intent.current_attempt_id
  AND attempt.state = 'quarantined_unknown'
  AND attempt.last_error_code = 'MISSING_DISPATCH_LEASE'
  AND intent.state = 'dispatching';

UPDATE inbound_deliveries
SET claimed_until = updated_at
WHERE state = 'delivering' AND claimed_until IS NULL;

UPDATE blob_deletions
SET claimed_until = updated_at
WHERE state IN ('claimed', 'retry_wait') AND claimed_until IS NULL;

ALTER TABLE outbound_attempts
  ALTER COLUMN route_snapshot SET NOT NULL,
  ADD CONSTRAINT outbound_attempts_route_snapshot_shape CHECK (
    jsonb_typeof(route_snapshot) = 'object'
    AND route_snapshot ->> 'schemaVersion' = 'v1'
  ),
  ADD CONSTRAINT outbound_attempts_claimed_until_state CHECK (
    (state = 'dispatching') = (claimed_until IS NOT NULL)
  ),
  ADD CONSTRAINT outbound_attempts_tenant_intent_attempt_unique
    UNIQUE (tenant_id, intent_id, attempt_id);

ALTER TABLE inbound_deliveries
  ADD CONSTRAINT inbound_deliveries_claimed_until_state CHECK (
    (state = 'delivering') = (claimed_until IS NOT NULL)
  );

ALTER TABLE blob_deletions
  ADD CONSTRAINT blob_deletions_claimed_until_state CHECK (
    (state IN ('claimed', 'retry_wait')) = (claimed_until IS NOT NULL)
  );

ALTER TABLE inbound_receipts
  ADD CONSTRAINT inbound_receipts_claimed_until_state CHECK (
    claimed_until IS NULL
    OR state IN ('acquiring', 'routing', 'delivering', 'retry_wait')
  );

ALTER TABLE outbound_intents
  DROP CONSTRAINT outbound_intents_current_attempt_fk,
  ADD CONSTRAINT outbound_intents_current_attempt_fk
    FOREIGN KEY (tenant_id, intent_id, current_attempt_id)
    REFERENCES outbound_attempts (tenant_id, intent_id, attempt_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE reconciliation_decisions
  DROP CONSTRAINT reconciliation_decisions_tenant_id_attempt_id_fkey,
  ADD CONSTRAINT reconciliation_decisions_same_intent_attempt_fk
    FOREIGN KEY (tenant_id, intent_id, attempt_id)
    REFERENCES outbound_attempts (tenant_id, intent_id, attempt_id);

CREATE FUNCTION mail_edge_forbid_attempt_route_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.binding_id IS DISTINCT FROM OLD.binding_id
    OR NEW.binding_version IS DISTINCT FROM OLD.binding_version
    OR NEW.route_snapshot IS DISTINCT FROM OLD.route_snapshot
    OR NEW.transmission_blob_id IS DISTINCT FROM OLD.transmission_blob_id
    OR NEW.recipient_group IS DISTINCT FROM OLD.recipient_group
    OR NEW.recipient_group_digest IS DISTINCT FROM OLD.recipient_group_digest
  THEN
    RAISE EXCEPTION 'outbound attempt route and payload snapshots are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER outbound_attempts_immutable_route
  BEFORE UPDATE OF binding_id, binding_version, route_snapshot, transmission_blob_id,
    recipient_group, recipient_group_digest
  ON outbound_attempts
  FOR EACH ROW EXECUTE FUNCTION mail_edge_forbid_attempt_route_mutation();

CREATE OR REPLACE FUNCTION mail_edge_require_available_blob()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_column text := TG_ARGV[0];
  candidate_blob_id uuid;
  candidate_status text;
  allow_corrupt boolean := coalesce(TG_ARGV[1], 'false') = 'true';
BEGIN
  candidate_blob_id := (to_jsonb(NEW) ->> candidate_column)::uuid;
  IF candidate_blob_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- FOR UPDATE conflicts with a purge claim's row lock. Whichever transaction wins
  -- forces the loser to observe either the new reference or purge_pending state.
  SELECT status INTO candidate_status
  FROM raw_blobs
  WHERE tenant_id = NEW.tenant_id AND blob_id = candidate_blob_id
  FOR UPDATE;

  IF candidate_status IS DISTINCT FROM 'available'
    AND NOT (allow_corrupt AND candidate_status = 'corrupt')
  THEN
    RAISE EXCEPTION 'workflow references a blob that is not available'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER raw_blob_derivations_available_source_blob
  BEFORE INSERT OR UPDATE OF source_blob_id ON raw_blob_derivations
  FOR EACH ROW EXECUTE FUNCTION mail_edge_require_available_blob('source_blob_id');
CREATE TRIGGER raw_blob_derivations_available_derived_blob
  BEFORE INSERT OR UPDATE OF derived_blob_id ON raw_blob_derivations
  FOR EACH ROW EXECUTE FUNCTION mail_edge_require_available_blob('derived_blob_id');
CREATE TRIGGER legal_holds_referenceable_blob
  BEFORE INSERT OR UPDATE OF blob_id, released_at ON legal_holds
  FOR EACH ROW WHEN (NEW.released_at IS NULL)
  EXECUTE FUNCTION mail_edge_require_available_blob('blob_id', 'true');

DROP VIEW raw_blob_reference_summary;
DROP VIEW raw_blob_references;

CREATE VIEW raw_blob_references
WITH (security_barrier = true, security_invoker = true)
AS
  SELECT tenant_id, raw_blob_id AS blob_id, 'inbound_receipt'::text AS reference_kind
    FROM inbound_receipts
    WHERE raw_blob_id IS NOT NULL AND state <> 'purged'
  UNION ALL
  SELECT tenant_id, raw_blob_id, 'outbound_intent_source'
    FROM outbound_intents
  UNION ALL
  SELECT tenant_id, transmission_blob_id, 'outbound_intent_transmission'
    FROM outbound_intents
  UNION ALL
  SELECT tenant_id, transmission_blob_id, 'outbound_attempt_transmission'
    FROM outbound_attempts
  UNION ALL
  SELECT tenant_id, source_blob_id, 'derivation_source'
    FROM raw_blob_derivations
  UNION ALL
  SELECT tenant_id, derived_blob_id, 'derivation_output'
    FROM raw_blob_derivations
  UNION ALL
  SELECT tenant_id, blob_id, 'legal_hold'
    FROM legal_holds
    WHERE released_at IS NULL;

CREATE VIEW raw_blob_reference_summary
WITH (security_barrier = true, security_invoker = true)
AS
  SELECT tenant_id, blob_id, count(*)::bigint AS reference_count
  FROM raw_blob_references
  GROUP BY tenant_id, blob_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM audit_events WHERE tenant_id IS NULL) THEN
    RAISE EXCEPTION 'tenantless audit events must be migrated before storage hardening';
  END IF;
END
$$;

ALTER TABLE audit_events ALTER COLUMN tenant_id SET NOT NULL;

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOR tenant_table IN
    SELECT table_row.relname
    FROM pg_class AS table_row
    JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
    JOIN pg_attribute AS tenant_column
      ON tenant_column.attrelid = table_row.oid
     AND tenant_column.attname = 'tenant_id'
     AND NOT tenant_column.attisdropped
    WHERE namespace_row.nspname = 'public'
      AND table_row.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tenant_table);
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION mail_edge_ensure_monthly_partitions(reference_time timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  month_start timestamptz;
  month_end timestamptz;
  month_suffix text;
  month_offset integer;
  feedback_table text;
  audit_table text;
BEGIN
  FOR month_offset IN 0..3 LOOP
    month_start := date_trunc('month', reference_time) + make_interval(months => month_offset);
    month_end := month_start + interval '1 month';
    month_suffix := to_char(month_start AT TIME ZONE 'UTC', 'YYYYMM');
    feedback_table := 'provider_feedback_events_' || month_suffix;
    audit_table := 'audit_events_' || month_suffix;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.provider_feedback_events FOR VALUES FROM (%L) TO (%L)',
      feedback_table,
      month_start,
      month_end
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.audit_events FOR VALUES FROM (%L) TO (%L)',
      audit_table,
      month_start,
      month_end
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', feedback_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', feedback_table);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', audit_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', audit_table);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = feedback_table
        AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I USING (tenant_id = public.mail_edge_current_tenant_id()) WITH CHECK (tenant_id = public.mail_edge_current_tenant_id())',
        feedback_table
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = audit_table
        AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I USING (tenant_id = public.mail_edge_current_tenant_id()) WITH CHECK (tenant_id = public.mail_edge_current_tenant_id())',
        audit_table
      );
    END IF;
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION mail_edge_ensure_monthly_partitions(timestamptz) FROM PUBLIC;

CREATE INDEX blob_ingest_stages_cleanup_pending
  ON blob_ingest_stages (tenant_id, updated_at, stage_id)
  WHERE state IN ('abandoned', 'promoted') AND cleanup_completed_at IS NULL;

COMMENT ON COLUMN outbound_attempts.route_snapshot IS
  'Immutable exact provider route used by this attempt; never reconstructed from mutable route rows.';
COMMENT ON COLUMN raw_blobs.corruption_detected_at IS
  'Fence timestamp that integrity proof must postdate before corrupt-to-available restoration.';
