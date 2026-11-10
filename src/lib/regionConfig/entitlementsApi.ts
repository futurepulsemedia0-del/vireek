// Supabase access for per-account module entitlements (read-only for tenants).
// Writes are staff-only and enforced server-side by staff_set_module_entitlement().
import { supabase } from '@/lib/supabase';
import { parseEntitledModules } from './gate';

/** Module keys switched ON for the signed-in tenant's account. Throws a safe-to-show Error. */
export async function fetchMyModuleKeys(): Promise<Set<string>> {
  const { data, error } = await supabase.rpc('get_my_module_entitlements');
  if (error) throw new Error('Could not load your account modules.');
  return parseEntitledModules(data);
}
