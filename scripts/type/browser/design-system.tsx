// Harness entry: the REAL /dev/design-system page.
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { DevDesignSystemPage } from '@/pages/DevDesignSystemPage';

createRoot(document.getElementById('root')!).render(<DevDesignSystemPage />);
