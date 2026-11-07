import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { cssVars } from './cssVars';

describe('cssVars', () => {
  it('drops undefined and keeps custom properties', () => {
    expect(cssVars({ '--a': '4px', '--b': undefined, '--c': 2 })).toEqual({ '--a': '4px', '--c': 2 });
  });
  it('applies custom properties to the DOM', () => {
    const { container } = render(<div style={cssVars({ '--w': '40%' })} />);
    expect((container.firstChild as HTMLElement).style.getPropertyValue('--w')).toBe('40%');
  });
});
