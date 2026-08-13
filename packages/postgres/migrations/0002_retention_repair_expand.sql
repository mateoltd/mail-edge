-- Additive retention, repair, and transition guards. Compatible with the 0001 application.

ALTER TABLE provider_feedback_events
  ADD COLUMN projected_at timestamptz;

ALTER TABLE blob_ingest_stages
  ADD COLUMN cleanup_completed_at timestamptz;

CREATE INDEX blob_ingest_stages_cleanup
  ON blob_ingest_stages (tenant_id, expires_at, stage_id)
  WHERE state = 'abandoned' AND cleanup_completed_at IS NULL;

ALTER TABLE provider_feedback_events_default ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON provider_feedback_events_default
  USING (tenant_id = mail_edge_current_tenant_id())
  WITH CHECK (tenant_id = mail_edge_current_tenant_id());

ALTER TABLE audit_events_default ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events_default
  USING (tenant_id = mail_edge_current_tenant_id())
  WITH CHECK (tenant_id = mail_edge_current_tenant_id());

CREATE TABLE blob_orphan_observations (
  tenant_id uuid NOT NULL,
  blob_id uuid NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  observation_count integer NOT NULL CHECK (observation_count > 0),
  PRIMARY KEY (tenant_id, blob_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, blob_id) REFERENCES raw_blobs (tenant_id, blob_id),
  CHECK (last_observed_at >= first_observed_at)
);

ALTER TABLE blob_orphan_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON blob_orphan_observations
  USING (tenant_id = mail_edge_current_tenant_id())
  WITH CHECK (tenant_id = mail_edge_current_tenant_id());

CREATE VIEW raw_blob_references
WITH (security_barrier = true)
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
WITH (security_barrier = true)
AS
  SELECT tenant_id, blob_id, count(*)::bigint AS reference_count
  FROM raw_blob_references
  GROUP BY tenant_id, blob_id;

CREATE FUNCTION mail_edge_require_available_blob()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_column text := TG_ARGV[0];
  candidate_blob_id uuid;
  candidate_status text;
BEGIN
  candidate_blob_id := (to_jsonb(NEW) ->> candidate_column)::uuid;
  IF candidate_blob_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status INTO candidate_status
  FROM raw_blobs
  WHERE tenant_id = NEW.tenant_id AND blob_id = candidate_blob_id;

  IF candidate_status IS DISTINCT FROM 'available' THEN
    RAISE EXCEPTION 'workflow references a blob that is not available'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER inbound_receipts_available_blob
  BEFORE INSERT OR UPDATE OF raw_blob_id ON inbound_receipts
  FOR EACH ROW WHEN (NEW.raw_blob_id IS NOT NULL)
  EXECUTE FUNCTION mail_edge_require_available_blob('raw_blob_id');
CREATE TRIGGER outbound_intents_available_source_blob
  BEFORE INSERT OR UPDATE OF raw_blob_id ON outbound_intents
  FOR EACH ROW EXECUTE FUNCTION mail_edge_require_available_blob('raw_blob_id');
CREATE TRIGGER outbound_intents_available_transmission_blob
  BEFORE INSERT OR UPDATE OF transmission_blob_id ON outbound_intents
  FOR EACH ROW EXECUTE FUNCTION mail_edge_require_available_blob('transmission_blob_id');
CREATE TRIGGER outbound_attempts_available_transmission_blob
  BEFORE INSERT OR UPDATE OF transmission_blob_id ON outbound_attempts
  FOR EACH ROW EXECUTE FUNCTION mail_edge_require_available_blob('transmission_blob_id');

CREATE FUNCTION mail_edge_validate_state_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_allowed boolean := false;
  old_state text;
  new_state text;
BEGIN
  IF TG_TABLE_NAME = 'raw_blobs' THEN
    old_state := to_jsonb(OLD) ->> 'status';
    new_state := to_jsonb(NEW) ->> 'status';
  ELSE
    old_state := to_jsonb(OLD) ->> 'state';
    new_state := to_jsonb(NEW) ->> 'state';
  END IF;

  IF new_state = old_state THEN
    RETURN NEW;
  END IF;

  transition_allowed := CASE TG_TABLE_NAME
    WHEN 'route_bindings' THEN
      (old_state, new_state) IN (
        ('draft', 'testing'),
        ('testing', 'active'),
        ('testing', 'failed'),
        ('active', 'draining'),
        ('draining', 'retired'),
        ('failed', 'testing')
      )
    WHEN 'blob_ingest_stages' THEN
      (old_state, new_state) IN (
        ('reserved', 'uploading'),
        ('reserved', 'abandoned'),
        ('uploading', 'uploaded'),
        ('uploading', 'abandoned'),
        ('uploaded', 'verified'),
        ('uploaded', 'abandoned'),
        ('verified', 'promoting'),
        ('verified', 'abandoned'),
        ('promoting', 'promoted'),
        ('promoting', 'abandoned')
      )
    WHEN 'raw_blobs' THEN
      (old_state, new_state) IN (
        ('available', 'purge_pending'),
        ('available', 'corrupt'),
        ('corrupt', 'available'),
        ('purge_pending', 'available'),
        ('purge_pending', 'deleted'),
        ('purge_pending', 'corrupt')
      )
    WHEN 'blob_deletions' THEN
      (old_state, new_state) IN (
        ('claimed', 'object_deleted'),
        ('claimed', 'retry_wait'),
        ('claimed', 'failed'),
        ('retry_wait', 'claimed'),
        ('retry_wait', 'failed'),
        ('object_deleted', 'completed')
      )
    WHEN 'inbound_receipts' THEN
      (old_state, new_state) IN (
        ('received', 'acquiring'),
        ('received', 'stored'),
        ('acquiring', 'stored'),
        ('acquiring', 'retry_wait'),
        ('acquiring', 'quarantined'),
        ('received', 'quarantined'),
        ('stored', 'quarantined'),
        ('routing', 'quarantined'),
        ('retry_wait', 'quarantined'),
        ('retry_wait', 'acquiring'),
        ('retry_wait', 'routing'),
        ('retry_wait', 'delivering'),
        ('stored', 'routing'),
        ('stored', 'purged'),
        ('routing', 'delivering'),
        ('routing', 'retry_wait'),
        ('routing', 'dead_letter'),
        ('delivering', 'delivered'),
        ('delivering', 'retry_wait'),
        ('delivering', 'dead_letter'),
        ('delivered', 'purged'),
        ('dead_letter', 'purged'),
        ('quarantined', 'stored')
      )
    WHEN 'inbound_deliveries' THEN
      (old_state, new_state) IN (
        ('ready', 'delivering'),
        ('delivering', 'delivered'),
        ('delivering', 'retry_wait'),
        ('delivering', 'dead_letter'),
        ('retry_wait', 'delivering'),
        ('retry_wait', 'dead_letter')
      )
    WHEN 'outbound_intents' THEN
      (old_state, new_state) IN (
        ('accepted', 'ready'),
        ('accepted', 'canceled'),
        ('accepted', 'quarantined_unknown'),
        ('ready', 'dispatching'),
        ('ready', 'canceled'),
        ('ready', 'quarantined_unknown'),
        ('dispatching', 'provider_accepted'),
        ('dispatching', 'retry_wait'),
        ('dispatching', 'failed_not_sent'),
        ('dispatching', 'quarantined_unknown'),
        ('retry_wait', 'ready'),
        ('retry_wait', 'quarantined_unknown'),
        ('quarantined_unknown', 'provider_accepted'),
        ('quarantined_unknown', 'failed_not_sent'),
        ('quarantined_unknown', 'ready')
      )
    WHEN 'outbound_attempts' THEN
      (old_state, new_state) IN (
        ('dispatching', 'provider_accepted'),
        ('dispatching', 'retry_wait'),
        ('dispatching', 'failed_not_sent'),
        ('dispatching', 'quarantined_unknown'),
        ('retry_wait', 'dispatching'),
        ('retry_wait', 'failed_not_sent'),
        ('retry_wait', 'quarantined_unknown'),
        ('quarantined_unknown', 'provider_accepted'),
        ('quarantined_unknown', 'failed_not_sent')
      )
    ELSE false
  END;

  IF NOT transition_allowed THEN
    RAISE EXCEPTION 'illegal state transition on %', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER route_bindings_state_transition
  BEFORE UPDATE OF state ON route_bindings
  FOR EACH ROW EXECUTE FUNCTION mail_edge_validate_state_transition();
CREATE TRIGGER blob_ingest_stages_state_transition
  BEFORE UPDATE OF state ON blob_ingest_stages
  FOR EACH ROW EXECUTE FUNCTION mail_edge_validate_state_transition();
CREATE TRIGGER raw_blobs_state_transition
  BEFORE UPDATE OF status ON raw_blobs
  FOR EACH ROW EXECUTE FUNCTION mail_edge_validate_state_transition();
CREATE TRIGGER blob_deletions_state_transition
  BEFORE UPDATE OF state ON blob_deletions
  FOR EACH ROW EXECUTE FUNCTION mail_edge_validate_state_transition();
CREATE TRIGGER inbound_receipts_state_transition
  BEFORE UPDATE OF state ON inbound_receipts
  FOR EACH ROW EXECUTE FUNCTION mail_edge_validate_state_transition();
CREATE TRIGGER inbound_deliveries_state_transition
  BEFORE UPDATE OF state ON inbound_deliveries
  FOR EACH ROW EXECUTE FUNCTION mail_edge_validate_state_transition();
CREATE TRIGGER outbound_intents_state_transition
  BEFORE UPDATE OF state ON outbound_intents
  FOR EACH ROW EXECUTE FUNCTION mail_edge_validate_state_transition();
CREATE TRIGGER outbound_attempts_state_transition
  BEFORE UPDATE OF state ON outbound_attempts
  FOR EACH ROW EXECUTE FUNCTION mail_edge_validate_state_transition();

CREATE FUNCTION mail_edge_due_wakeups(scan_limit integer)
RETURNS TABLE (
  tenant_id uuid,
  wakeup_type text,
  workflow_id uuid,
  due_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT due.tenant_id, due.wakeup_type, due.workflow_id, due.due_at
  FROM (
    SELECT r.tenant_id, 'inbound_receipt'::text, r.receipt_id,
      coalesce(r.next_action_at, r.created_at)
    FROM inbound_receipts AS r
    WHERE r.state IN ('received', 'stored', 'retry_wait')
      AND coalesce(r.next_action_at, r.created_at) <= clock_timestamp()
    UNION ALL
    SELECT i.tenant_id, 'outbound_intent'::text, i.intent_id,
      coalesce(i.next_action_at, i.created_at)
    FROM outbound_intents AS i
    WHERE i.state IN ('accepted', 'ready', 'retry_wait')
      AND coalesce(i.next_action_at, i.created_at) <= clock_timestamp()
    UNION ALL
    SELECT d.tenant_id, 'application_delivery'::text, d.delivery_id,
      coalesce(d.next_action_at, d.created_at)
    FROM inbound_deliveries AS d
    WHERE d.state IN ('ready', 'retry_wait')
      AND coalesce(d.next_action_at, d.created_at) <= clock_timestamp()
    UNION ALL
    SELECT f.tenant_id, 'feedback_event'::text, f.feedback_event_id, f.received_at
    FROM provider_feedback_events AS f
    WHERE f.projected_at IS NULL
  ) AS due (tenant_id, wakeup_type, workflow_id, due_at)
  ORDER BY due.due_at, due.workflow_id
  LIMIT greatest(1, least(scan_limit, 1000))
$$;

REVOKE ALL ON FUNCTION mail_edge_due_wakeups(integer) FROM PUBLIC;

CREATE FUNCTION mail_edge_ensure_monthly_partitions(reference_time timestamptz)
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
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', audit_table);
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
SELECT mail_edge_ensure_monthly_partitions(clock_timestamp());

UPDATE mail_edge_schema_epoch
SET epoch = 1,
    minimum_application_epoch = 1,
    updated_at = clock_timestamp()
WHERE singleton;

COMMENT ON TABLE blob_orphan_observations IS
  'Two-scan evidence for unreferenced available blobs; final claims always recheck references and holds.';
COMMENT ON FUNCTION mail_edge_due_wakeups(integer) IS
  'Restricted durable-state repair scan; returns opaque workflow identifiers only.';
