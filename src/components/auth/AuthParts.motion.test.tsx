import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthSidePanel } from './AuthParts';

// Regression: the `motion` prop once shadowed framer-motion's `motion`,
// making <motion.div> undefined → React error #130 on every auth page.
describe('AuthSidePanel', () => {
  it.each(['still', 'animated'] as const)('renders without crashing (motion=%s)', (m) => {
    expect(() =>
      render(
        <MemoryRouter>
          <AuthSidePanel motion={m} />
        </MemoryRouter>,
      ),
    ).not.toThrow();
  });
  it('renders with default props', () => {
    expect(() => render(<MemoryRouter><AuthSidePanel /></MemoryRouter>)).not.toThrow();
  });
});
