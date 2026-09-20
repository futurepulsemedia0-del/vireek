/*
  # no-show-reschedule + vip-customer-auto-tag automation support

  - jobs.no_show_text_sent_at: idempotency guard so the reschedule text
    only goes out once per no-show, even if the sweep runs every few minutes.
  - apply_vip_customer_tags(): set-based sweep that tags customers who cross
    a lifetime-spend or completed-job-count threshold, per business, reading
    the threshold from automation_installs.config (defaults: $1000 / 5 jobs
    if a business never configured it).
*/

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS no_show_text_sent_at timestamptz;

CREATE OR REPLACE FUNCTION apply_vip_customer_tags()
RETURNS TABLE(user_id uuid, customers_tagged integer) AS $$
DECLARE
  install RECORD;
  spend_threshold numeric;
  count_threshold integer;
  tagged_count integer;
BEGIN
  FOR install IN
    SELECT ai.user_id, ai.config
    FROM automation_installs ai
    WHERE ai.template_slug = 'vip-customer-auto-tag' AND ai.status = 'active'
  LOOP
    spend_threshold := COALESCE((install.config->>'lifetime_spend_threshold')::numeric, 1000);
    count_threshold := COALESCE((install.config->>'job_count_threshold')::integer, 5);

    WITH customer_totals AS (
      SELECT
        c.id,
        COALESCE(SUM(j.invoice_amount) FILTER (WHERE j.invoice_status = 'paid'), 0) AS lifetime_spend,
        COUNT(j.id) FILTER (WHERE j.job_status = 'completed') AS completed_jobs
      FROM customers c
      LEFT JOIN jobs j ON j.user_id = c.user_id AND j.customer_phone = c.phone AND c.phone IS NOT NULL
      WHERE c.user_id = install.user_id
        AND c.lifecycle_stage != 'vip'
      GROUP BY c.id
    ),
    qualifying AS (
      SELECT id FROM customer_totals
      WHERE lifetime_spend >= spend_threshold OR completed_jobs >= count_threshold
    )
    UPDATE customers
    SET lifecycle_stage = 'vip',
        tags = CASE WHEN 'VIP' = ANY(tags) THEN tags ELSE array_append(tags, 'VIP') END,
        updated_at = now()
    WHERE id IN (SELECT id FROM qualifying);

    GET DIAGNOSTICS tagged_count = ROW_COUNT;
    user_id := install.user_id;
    customers_tagged := tagged_count;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
