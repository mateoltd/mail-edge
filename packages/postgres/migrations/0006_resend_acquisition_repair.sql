CREATE OR REPLACE FUNCTION mail_edge_due_wakeups(scan_limit integer)
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
      coalesce(r.next_action_at, r.claimed_until, r.created_at)
    FROM inbound_receipts AS r
    WHERE (
        r.state IN ('received', 'stored', 'retry_wait')
        AND coalesce(r.next_action_at, r.created_at) <= clock_timestamp()
      ) OR (
        r.state = 'acquiring'
        AND r.claimed_until <= clock_timestamp()
      )
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
