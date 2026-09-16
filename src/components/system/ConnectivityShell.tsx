import { useLocation } from 'react-router-dom';
import { useConnectivity } from '@/contexts/ConnectivityContext';
import { isMaintenanceAllowlisted } from '@/lib/connectivity';
import { OfflineBanner } from '@/components/system/OfflineBanner';
import { DegradedBanner } from '@/components/system/DegradedBanner';
import { MaintenanceScreen } from '@/components/system/MaintenanceScreen';

/**
 * Sits under providers, above (or wrapping) the app tree.
 * - Offline → banner only
 * - Degraded → dismissible banner
 * - Maintenance → full screen unless allowlisted route
 */
export function ConnectivityShell({ children }: { children: React.ReactNode }) {
  const { mode } = useConnectivity();
  const location = useLocation();

  const blockForMaintenance =
    mode === 'maintenance' && !isMaintenanceAllowlisted(location.pathname);

  if (blockForMaintenance) {
    return <MaintenanceScreen />;
  }

  return (
    <>
      <OfflineBanner />
      <DegradedBanner />
      {children}
    </>
  );
}
