/*
  # Enterprise demo bookings

  ## چرا این migration لازم است
  `src/components/EnterpriseDemoBookingCalendar.tsx` (استفاده‌شده در
  `/contact` و `/demo`) به `@/lib/enterpriseDemoBooking` نیاز دارد که تا
  الان اصلاً در repo وجود نداشت — همین باعث fail شدن کامل build در Vercel
  می‌شد (`Could not resolve "@/lib/enterpriseDemoBooking"`، دقیقاً بعد از
  رفع مشکل print.css ظاهر می‌شود).

  برای اینکه این calendar واقعاً کار کند (نه فقط UI بدون backend)، به یک
  جدول واقعی نیاز است که:
  1. از دوبار-بوک‌شدن یک slot توسط دو نفر مختلف جلوگیری کند
     (`slot_start UNIQUE`).
  2. اجازه بدهد بازدیدکننده‌های ناشناس (بدون لاگین) هم بوک کنند — دقیقاً
     مثل `sales_inquiries`.
  3. ایمیل/نام/شرکت لیدها را عمومی نکند — چک "این slot آزاده یا نه" باید
     بدون افشای اطلاعات لیدهای دیگر انجام شود؛ به همین دلیل یک تابع
     SECURITY DEFINER جدا (`get_booked_demo_slot_starts`) فقط زمان‌های
     پرشده را برمی‌گرداند، نه اطلاعات شخصی.

  ## چه چیزی اضافه می‌شود

  ### demo_bookings
  - `id` uuid PK
  - `full_name`, `work_email`, `company_name` (text, not null)
  - `phone`, `team_size`, `message` (text, nullable)
  - `slot_start`, `slot_end` (timestamptz, not null) — `slot_start` UNIQUE
    تا insert همزمان روی یک زمان با conflict رد شود.
  - `status` (text, default 'scheduled')
  - `created_at` (timestamptz, default now)

  ### get_booked_demo_slot_starts(p_start, p_end)
  تابع عمومی (SECURITY DEFINER) که فقط لیست `slot_start` های پرشده در بازه
  را برمی‌گرداند — بدون نام/ایمیل/شرکت — تا فرانت بتواند slotهای آزاد را
  محاسبه کند بدون اینکه به جدول دسترسی مستقیم SELECT داشته باشد.

  ## امنیت
  - RLS روشن؛ INSERT عمومی (anon + authenticated) مثل sales_inquiries.
  - SELECT مستقیم روی جدول فقط برای admin (همان الگوی sales_inquiries).
  - تنها راه عمومی برای "دیدن" چیزی از این جدول همان تابع محدودشده است.
*/

CREATE TABLE IF NOT EXISTS demo_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  work_email text NOT NULL,
  company_name text NOT NULL,
  phone text,
  team_size text,
  message text,
  slot_start timestamptz NOT NULL,
  slot_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'canceled', 'no_show')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slot_start)
);

CREATE INDEX IF NOT EXISTS idx_demo_bookings_slot_start ON demo_bookings(slot_start);

ALTER TABLE demo_bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_insert_demo_bookings" ON demo_bookings;
CREATE POLICY "public_insert_demo_bookings"
ON demo_bookings FOR INSERT
TO anon, authenticated
WITH CHECK (true);

DROP POLICY IF EXISTS "admin_select_demo_bookings" ON demo_bookings;
CREATE POLICY "admin_select_demo_bookings"
ON demo_bookings FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
);

DROP POLICY IF EXISTS "admin_update_demo_bookings" ON demo_bookings;
CREATE POLICY "admin_update_demo_bookings"
ON demo_bookings FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
);

DROP POLICY IF EXISTS "admin_delete_demo_bookings" ON demo_bookings;
CREATE POLICY "admin_delete_demo_bookings"
ON demo_bookings FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
);

-- Public, PII-free availability check.
CREATE OR REPLACE FUNCTION public.get_booked_demo_slot_starts(p_start timestamptz, p_end timestamptz)
RETURNS TABLE (slot_start timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT db.slot_start
  FROM demo_bookings db
  WHERE db.slot_start >= p_start
    AND db.slot_start < p_end
    AND db.status = 'scheduled';
$$;

GRANT EXECUTE ON FUNCTION public.get_booked_demo_slot_starts(timestamptz, timestamptz) TO anon, authenticated;
