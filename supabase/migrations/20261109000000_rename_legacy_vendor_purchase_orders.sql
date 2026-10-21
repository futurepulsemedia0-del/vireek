-- STEP A. Run first, alone. Safe: renames the EMPTY vendor-procurement purchase_orders table out of the way.
-- Aborts (changing nothing) if the table has rows or is not the vendor-procurement variant.
SET lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.purchase_orders') IS NOT NULL
     AND to_regclass('public.purchase_orders_vendor_os_legacy') IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.purchase_orders) THEN
      RAISE EXCEPTION 'purchase_orders has rows - aborting, nothing changed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'rfq_id') THEN
      RAISE EXCEPTION 'purchase_orders is not the vendor-procurement variant - aborting, nothing changed';
    END IF;
    ALTER TABLE public.purchase_orders RENAME TO purchase_orders_vendor_os_legacy;
  END IF;
END $$;
