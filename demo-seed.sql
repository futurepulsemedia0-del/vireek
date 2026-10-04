-- Demo data: 6 days of normal behaviour, then a degrading last 24h (HVAC condenser).
INSERT INTO pio_telemetry (user_id, device_id, equipment_id, metric, value, recorded_at)
SELECT d.user_id, d.id, d.equipment_id, m.metric,
  CASE WHEN t.ts < now() - interval '24 hours' THEN m.base + (random() - 0.5) * m.noise * 2
       ELSE m.base + m.drift * (1 - extract(epoch FROM (now() - t.ts)) / 86400.0) + (random() - 0.5) * m.noise * 2 END,
  t.ts
FROM pio_devices d
CROSS JOIN (VALUES ('vibration_mm_s', 4.0, 0.3, 3.2), ('current_a', 11.0, 0.4, 2.8), ('temp_delta_f', 18.0, 0.8, -5.0)) AS m(metric, base, noise, drift)
CROSS JOIN LATERAL generate_series(now() - interval '6 days', now(), interval '10 minutes') AS t(ts)
WHERE d.id = (SELECT id FROM pio_devices ORDER BY created_at DESC LIMIT 1)
ON CONFLICT DO NOTHING;
