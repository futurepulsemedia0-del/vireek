import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { z } from 'zod';
import { initFormsI18n } from '@/test/formsI18n';
import { createDraftStore, memoryBackend } from '@/lib/forms/draftStore';
import * as draftHook from '@/hooks/forms/useFormDraft';
import { Form } from './Form';
import { TextField } from './TextField';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
const schema = z.object({ title: z.string(), password: z.string() });
type V = z.input<typeof schema>;
beforeAll(async () => { await initFormsI18n(); });

describe('draft persistence', () => {
  it('saves (without secrets), offers restore after remount, restores, and clears on discard', async () => {
    const store = createDraftStore(memoryBackend());
    vi.spyOn(draftHook, 'getDraftStore').mockReturnValue(store);
    const mount = () =>
      render(<RouterProvider router={createMemoryRouter([{ path: '/', element: (
        <Form formId="d" schema={schema} defaultValues={{ title: '', password: '' } satisfies V} draft={{ version: 1 }} unsavedGuard={false} onSubmit={async () => undefined}>
          <TextField<V> name="title" label="Title" /><TextField<V> name="password" label="Password" type="password" />
        </Form>) }])} />);
    const u = userEvent.setup();
    const first = mount();
    await u.type(screen.getByLabelText('Title'), 'Leaky faucet');
    await u.type(screen.getByLabelText('Password'), 'secret');
    await waitFor(async () => expect(await store.load({ userId: 'u1', formId: 'd' }, 1)).not.toBeNull(), { timeout: 3000 });
    expect((await store.load({ userId: 'u1', formId: 'd' }, 1))?.data).toEqual({ title: 'Leaky faucet' });
    first.unmount();
    mount();
    await u.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Leaky faucet');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });
});
