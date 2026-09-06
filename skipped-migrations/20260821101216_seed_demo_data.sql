/*
# Seed demo data for one demo account

## What this migration does
Creates a demo user in auth.users, a fully-onboarded profile, and realistic
demo data across calls, leads, jobs, business_profile, integrations, and
ai_insights. This data is clearly marked as demo data so it can be distinguished
from real production data.

## Demo Account
- Email: demo@vireek.com
- Password: demodemo123 (set via auth.users table)
- The profile has onboarding_completed = true and plan = 'professional'

## Data Created
1. One profile row (professional plan, onboarding completed)
2. One business_profile row (plumbing business with hours, services, FAQs)
3. One integration row (Airtable connected)
4. Six calls with varied statuses, sentiments, and callers
5. Four leads linked to calls, at various pipeline stages
6. Three jobs with different statuses and invoice states
7. One team member (technician, active)
8. One ai_insight (pattern type)

## Important Notes
1. The demo user is created with a fixed UUID for reproducibility.
2. All demo data uses this fixed UUID as user_id.
3. The demo user's password is set to 'demodemo123' using crypt() with gen_salt.
4. This migration is idempotent — re-running will not duplicate data because
   it checks for existing demo data first.
*/

-- =============================================================
-- Create demo user in auth.users (idempotent)
-- =============================================================

DO $$
DECLARE
  demo_user_id uuid := 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  demo_user_exists boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM auth.users WHERE id = demo_user_id) INTO demo_user_exists;

  IF NOT demo_user_exists THEN
    INSERT INTO auth.users (
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      created_at,
      updated_at,
      raw_app_meta_data,
      raw_user_meta_data
    ) VALUES (
      demo_user_id,
      'authenticated',
      'authenticated',
      'demo@vireek.com',
      crypt('demodemo123', gen_salt('bf')),
      now(),
      now(),
      now(),
      '{"provider": "email", "providers": ["email"]}'::jsonb,
      '{}'::jsonb
    );
  END IF;
END $$;

-- =============================================================
-- Upsert demo profile
-- =============================================================

INSERT INTO profiles (id, email, full_name, company_name, phone, plan, minutes_used_this_month, minutes_included, status, role, onboarding_completed, forwarding_number, external_id)
VALUES (
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'demo@vireek.com',
  'Mike Rodriguez',
  'BluePipe Plumbing Co.',
  '+1-415-555-0142',
  'professional',
  342,
  1500,
  'active',
  'owner',
  true,
  '+1-415-555-0199',
  'airtable_rec_001'
)
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  full_name = EXCLUDED.full_name,
  company_name = EXCLUDED.company_name,
  phone = EXCLUDED.phone,
  plan = EXCLUDED.plan,
  minutes_used_this_month = EXCLUDED.minutes_used_this_month,
  minutes_included = EXCLUDED.minutes_included,
  status = EXCLUDED.status,
  role = EXCLUDED.role,
  onboarding_completed = EXCLUDED.onboarding_completed,
  forwarding_number = EXCLUDED.forwarding_number,
  external_id = EXCLUDED.external_id;

-- =============================================================
-- Upsert business_profile
-- =============================================================

INSERT INTO business_profile (user_id, business_hours, services_offered, greeting_script, faqs, service_area)
VALUES (
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  '{
    "mon": {"open": "07:00", "close": "19:00"},
    "tue": {"open": "07:00", "close": "19:00"},
    "wed": {"open": "07:00", "close": "19:00"},
    "thu": {"open": "07:00", "close": "19:00"},
    "fri": {"open": "07:00", "close": "19:00"},
    "sat": {"open": "08:00", "close": "17:00"},
    "sun": {"open": "closed", "close": "closed"}
  }'::jsonb,
  ARRAY['Emergency Plumbing', 'Drain Cleaning', 'Water Heater Repair', 'Leak Detection', 'Sewer Line Service', 'Faucet & Fixture Installation'],
  'Thank you for calling BluePipe Plumbing, this is Sarah. How can I help you today?',
  '[
    {"question": "What are your hours?", "answer": "We are open Monday through Friday 7am to 7pm, and Saturday 8am to 5pm. We offer 24/7 emergency service."},
    {"question": "Do you offer free estimates?", "answer": "Yes, we provide free estimates for all non-emergency work. Emergency calls have a standard dispatch fee."},
    {"question": "What areas do you serve?", "answer": "We serve the greater Bay Area including San Francisco, Oakland, Berkeley, and surrounding cities."},
    {"question": "Do you accept credit cards?", "answer": "Yes, we accept all major credit cards, debit cards, and offer financing options for larger projects."}
  ]'::jsonb,
  'Greater Bay Area: San Francisco, Oakland, Berkeley, Daly City, San Mateo, Fremont'
)
ON CONFLICT (user_id) DO UPDATE SET
  business_hours = EXCLUDED.business_hours,
  services_offered = EXCLUDED.services_offered,
  greeting_script = EXCLUDED.greeting_script,
  faqs = EXCLUDED.faqs,
  service_area = EXCLUDED.service_area;

-- =============================================================
-- Upsert integration
-- =============================================================

INSERT INTO integrations (user_id, integration_type, status, config)
VALUES (
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'airtable',
  'connected',
  '{"base_id": "appXX_demo_base", "table_name": "Calls", "sync_frequency": "real-time"}'::jsonb
)
ON CONFLICT DO NOTHING;

-- =============================================================
-- Insert team member (technician)
-- =============================================================

INSERT INTO team_members (account_owner_id, member_email, member_name, role, permissions, invite_status)
VALUES (
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'james@bluepipe.example',
  'James Chen',
  'technician',
  '{"can_view_billing": false, "can_manage_team": false, "can_edit_business_profile": false, "can_view_all_jobs": true}'::jsonb,
  'active'
)
ON CONFLICT DO NOTHING;

-- =============================================================
-- Insert demo calls (6 calls)
-- =============================================================

INSERT INTO calls (id, user_id, external_id, caller_phone, caller_name, call_datetime, duration_seconds, summary, transcript, recording_url, is_emergency, sentiment, status)
VALUES
  (
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'air_call_001',
    '+1-415-555-0188',
    'Sarah Mitchell',
    now() - interval '2 hours',
    184,
    'Caller reported a burst pipe under the kitchen sink. Water is actively leaking. Sarah dispatched an emergency plumber and scheduled a visit within 1 hour. Caller was stressed but satisfied with the quick response.',
    'Sarah: Thank you for calling BluePipe Plumbing, this is Sarah. How can I help you today?\nCaller: Hi, I have water pouring out from under my kitchen sink, I dont know what to do!\nSarah: I understand that sounds very stressful. Is the water still actively running?\nCaller: Yes, Ive tried turning the valve but it wont stop.\nSarah: Okay, this is an emergency. Im dispatching our nearest plumber right now. He should be there within the hour. Can you give me your address?\nCaller: 248 Oak Street, apartment 3B, Oakland.\nSarah: Got it. James is on his way. Try to contain the water with towels and buckets until he arrives. Stay safe.\nCaller: Thank you so much, I appreciate it.',
    NULL,
    true,
    'neutral',
    'booked'
  ),
  (
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'air_call_002',
    '+1-510-555-0231',
    'Robert Kim',
    now() - interval '5 hours',
    92,
    'Caller asked about water heater replacement cost. Sarah provided a rough estimate range and scheduled a free in-home consultation for Thursday morning.',
    'Sarah: Thank you for calling BluePipe Plumbing, this is Sarah. How can I help you today?\nCaller: Hi, my water heater is about 12 years old and I want to get a quote for replacing it.\nSarah: Absolutely, we can help with that. A standard replacement typically runs between $1,200 and $2,800 depending on the unit size and type. Would you like to schedule a free in-home consultation?\nCaller: That sounds great. Thursday morning would work.\nSarah: Perfect, I have 9am or 10am available on Thursday. Which works better?\nCaller: 10am please.\nSarah: Done. Our technician James will be at your home Thursday at 10am. Can I get your address?\nCaller: 1124 Cedar Lane, Berkeley.\nSarah: Got it. See you Thursday at 10am.',
    NULL,
    false,
    'positive',
    'booked'
  ),
  (
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a03',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'air_call_003',
    '+1-650-555-0145',
    'Linda Park',
    now() - interval '1 day',
    45,
    'Caller asked about drain cleaning service. Was price-shopping. Sarah quoted the standard rate and the caller said she would call back to compare prices.',
    'Sarah: Thank you for calling BluePipe Plumbing, this is Sarah. How can I help you today?\nCaller: How much do you charge for drain cleaning?\nSarah: Our standard drain cleaning is $189 for the first hour, and we charge by the half hour after that. Most jobs take about an hour.\nCaller: Okay, let me check with a couple other places and get back to you.\nSarah: Of course, feel free to call us anytime. Have a great day.',
    NULL,
    false,
    'neutral',
    'callback_requested'
  ),
  (
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a04',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'air_call_004',
    '+1-415-555-0999',
    'Unknown',
    now() - interval '1 day 3 hours',
    12,
    'Caller hung up after the greeting. Likely a robocall or wrong number.',
    'Sarah: Thank you for calling BluePipe Plumbing, this is Sarah. How can I help you today?\n[Caller hung up]',
    NULL,
    false,
    'neutral',
    'spam'
  ),
  (
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a05',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'air_call_005',
    '+1-510-555-0777',
    'David Thompson',
    now() - interval '2 days',
    156,
    'Caller reported slow-draining bathroom sink. Sarah scheduled a service appointment for Friday afternoon. Caller was pleasant and cooperative.',
    'Sarah: Thank you for calling BluePipe Plumbing, this is Sarah. How can I help you today?\nCaller: Hi, my bathroom sink has been draining really slowly for the past week and I think it needs professional attention.\nSarah: I can definitely help with that. Slow drains are one of our specialties. Would you like to schedule a service visit?\nCaller: Yes please. This Friday afternoon if possible.\nSarah: I have 2pm or 3:30pm available on Friday. Which works?\nCaller: 2pm is great.\nSarah: Perfect. James will come by Friday at 2pm. What is your address?\nCaller: 455 Pine Street, San Francisco.\nSarah: Got it. See you Friday at 2pm. Is there anything else I can help with?\nCaller: No, that is everything. Thank you.\nSarah: You are welcome. Have a great day.',
    NULL,
    false,
    'positive',
    'booked'
  ),
  (
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a06',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'air_call_006',
    '+1-415-555-0322',
    'Jennifer Walsh',
    now() - interval '3 days',
    210,
    'Caller had multiple questions about sewer line service and pricing. Sarah answered FAQs and scheduled a camera inspection for next Monday. Caller was detailed and asked good questions.',
    'Sarah: Thank you for calling BluePipe Plumbing, this is Sarah. How can I help you today?\nCaller: Hi, I think I might have a sewer line issue. There is a bad smell coming from the drain in my basement and the toilets are gurgling.\nSarah: That does sound like it could be a sewer line problem. We offer a camera inspection service that lets us see exactly what is going on. It is $350 and includes a full report.\nCaller: That sounds reasonable. When can you do the inspection?\nSarah: I can schedule you for Monday morning. Would 9am or 10am work?\nCaller: 9am please.\nSarah: Great. James will come Monday at 9am for the camera inspection. What is your address?\nCaller: 887 Mission Street, San Francisco.\nSarah: Got it. He will bring the camera equipment and give you a full report on site.\nCaller: Perfect, thank you so much.\nSarah: You are welcome. See you Monday.',
    NULL,
    false,
    'positive',
    'booked'
  )
ON CONFLICT DO NOTHING;

-- =============================================================
-- Insert demo leads (4 leads)
-- =============================================================

INSERT INTO leads (id, user_id, call_id, name, phone, email, service_interested, notes, stage)
VALUES
  (
    'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    'Sarah Mitchell',
    '+1-415-555-0188',
    NULL,
    'Emergency Plumbing',
    'Burst pipe under kitchen sink. Emergency dispatch. Job completed within 1 hour.',
    'won'
  ),
  (
    'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
    'Robert Kim',
    '+1-510-555-0231',
    'rkim@example.com',
    'Water Heater Repair',
    'Wants quote for water heater replacement. Consultation scheduled Thursday 10am.',
    'quoted'
  ),
  (
    'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a03',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a03',
    'Linda Park',
    '+1-650-555-0145',
    NULL,
    'Drain Cleaning',
    'Price-shopping. Said she would call back. Follow up recommended.',
    'new'
  ),
  (
    'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a04',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a05',
    'David Thompson',
    '+1-510-555-0777',
    NULL,
    'Drain Cleaning',
    'Slow-draining bathroom sink. Service appointment scheduled Friday 2pm.',
    'contacted'
  )
ON CONFLICT DO NOTHING;

-- =============================================================
-- Insert demo jobs (3 jobs)
-- =============================================================

INSERT INTO jobs (id, user_id, lead_id, call_id, customer_name, service_type, address, scheduled_datetime, assigned_technician_id, job_status, invoice_amount, invoice_status)
VALUES
  (
    'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    'Sarah Mitchell',
    'Emergency Plumbing',
    '248 Oak Street, Apt 3B, Oakland',
    now() - interval '1 hour',
    (SELECT id FROM team_members WHERE member_email = 'james@bluepipe.example' LIMIT 1),
    'completed',
    385.00,
    'paid'
  ),
  (
    'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
    'Robert Kim',
    'Water Heater Repair',
    '1124 Cedar Lane, Berkeley',
    now() + interval '2 days',
    (SELECT id FROM team_members WHERE member_email = 'james@bluepipe.example' LIMIT 1),
    'scheduled',
    NULL,
    'not_sent'
  ),
  (
    'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a03',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a04',
    'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a05',
    'David Thompson',
    'Drain Cleaning',
    '455 Pine Street, San Francisco',
    now() + interval '3 days',
    (SELECT id FROM team_members WHERE member_email = 'james@bluepipe.example' LIMIT 1),
    'scheduled',
    189.00,
    'sent'
  )
ON CONFLICT DO NOTHING;

-- =============================================================
-- Insert demo AI insight (1 insight)
-- =============================================================

INSERT INTO ai_insights (user_id, insight_type, title, description)
VALUES (
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'pattern',
  'After-hours calls trending up',
  'You have received 8 calls outside business hours in the past 7 days, up from 3 the previous week. Consider extending Saturday hours to 7pm or adding a Sunday emergency-only line to capture these leads before they call a competitor.'
)
ON CONFLICT DO NOTHING;
