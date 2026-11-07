-- READ-ONLY Phase 0 queries. Run in the Supabase SQL editor (service role) — they only SELECT.
-- Run in order. Nothing here modifies data.

-- 0) Which dispatch_decisions schema is actually deployed? (two migrations define it differently)
--    Expected for the rules engine: mode, explanation, recommended_technician_id, note.
--    If you see engine_version / source / breakdown instead, rules-path decisions were NEVER stored.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'dispatch_decisions'
ORDER BY ordinal_position;

-- 1) Near-tie rate per ε (platform-wide, last 180 days). Mirrors src/lib/dispatchTies.ts (k = 2 view).
WITH base AS (
  SELECT d.id, d.user_id, d.note,
    (SELECT array_agg((c->>'score')::numeric ORDER BY (c->>'score')::numeric DESC)
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.explanation->'candidates') = 'array' THEN d.explanation->'candidates' ELSE '[]'::jsonb END) c
      WHERE (c->>'eligible')::boolean IS TRUE AND c->>'score' IS NOT NULL) AS scores
  FROM dispatch_decisions d
  WHERE d.mode = 'auto' AND d.technician_id IS NOT NULL AND d.created_at >= now() - interval '180 days'
), usable AS (
  SELECT * FROM base WHERE scores IS NOT NULL AND cardinality(scores) >= 1
    AND COALESCE(note, '') NOT LIKE 'Skipped by system gates%'
)
SELECT eps.v AS eps,
       count(*) AS decisions,
       count(*) FILTER (WHERE cardinality(scores) >= 2 AND scores[1] - scores[2] <= eps.v) AS tied,
       round(100.0 * count(*) FILTER (WHERE cardinality(scores) >= 2 AND scores[1] - scores[2] <= eps.v) / NULLIF(count(*), 0), 2) AS tied_pct
FROM usable CROSS JOIN (SELECT unnest(ARRAY[0, 0.5, 1, 2, 3, 5]::numeric[]) AS v) eps
GROUP BY eps.v ORDER BY eps.v;

-- 2) Export for the CLI (copy result as JSON, save as rows.json). Last 180 days, auto decisions only.
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id', id, 'mode', mode, 'technician_id', technician_id, 'note', note, 'created_at', created_at, 'explanation', explanation)), '[]'::jsonb)
FROM dispatch_decisions
WHERE mode = 'auto' AND technician_id IS NOT NULL AND created_at >= now() - interval '180 days';

-- 3) Baseline first-time-fix rate for the power calculation (completed, non-rework jobs, last 180 days).
SELECT round(avg(CASE WHEN NOT EXISTS (SELECT 1 FROM jobs r WHERE r.rework_of_job_id = j.id AND r.is_rework) THEN 1 ELSE 0 END)::numeric, 3) AS ftf_rate,
       count(*) AS jobs
FROM jobs j
WHERE j.job_status = 'completed' AND COALESCE(j.is_rework, false) = false AND j.completed_at >= now() - interval '180 days'
  AND j.completed_at <= now() - interval '30 days';  -- let the callback window pass
