import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LanguageBadge } from './LanguageBadge';

describe('LanguageBadge', () => {
  it('shows the native name with the right direction', () => {
    render(<LanguageBadge lang="ar" />);
    const el = screen.getByText('العربية');
    expect(el.getAttribute('dir')).toBe('rtl');
    expect(el.getAttribute('lang')).toBe('ar');
  });
  it('renders nothing for English, unknown or junk', () => {
    const { container } = render(<><LanguageBadge lang="en" /><LanguageBadge lang={null} /><LanguageBadge lang="xx" /></>);
    expect(container.textContent).toBe('');
  });
  it('flags a degraded call', () => {
    render(<LanguageBadge lang="es" degraded />);
    expect(screen.getByLabelText('Caller language: Spanish').getAttribute('title')).toMatch(/captions only/);
  });
});
