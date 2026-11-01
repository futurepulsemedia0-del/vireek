import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom';
import { z } from 'zod';
import { initFormsI18n } from '@/test/formsI18n';
import { Form } from './Form';
import { TextField } from './TextField';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
const schema = z.object({ name: z.string() });
type V = z.input<typeof schema>;

function setup() {
  const router = createMemoryRouter(
    [
      { path: '/', element: (<><Link to="/other">go</Link><Form formId="u" schema={schema} defaultValues={{ name: '' } satisfies V} onSubmit={async () => undefined}><TextField<V> name="name" label="Name" /></Form></>) },
      { path: '/other', element: <p>other page</p> },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
beforeAll(async () => { await initFormsI18n(); });

describe('unsaved changes guard', () => {
  it('does not block a clean form', async () => {
    const router = setup();
    await userEvent.click(screen.getByText('go'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/other'));
  });
  it('blocks route change when dirty; Stay keeps the user, Discard leaves', async () => {
    const u = userEvent.setup();
    const router = setup();
    await u.type(screen.getByLabelText('Name'), 'x');
    await u.click(screen.getByText('go'));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    await u.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await u.click(screen.getByText('go'));
    await u.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/other'));
  });
  it('registers beforeunload while dirty', async () => {
    setup();
    await userEvent.type(screen.getByLabelText('Name'), 'x');
    const ev = new Event('beforeunload', { cancelable: true });
    fireEvent(window, ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});
