import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { z } from 'zod';
import { initFormsI18n } from '@/test/formsI18n';
import { Form } from './Form';
import { TextField } from './TextField';
import { SubmitButton } from './SubmitButton';
import { emailField, textField } from '@/lib/forms/schemas';
import { phoneMask } from '@/lib/forms/phone';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));

const schema = z.object({ name: textField(), email: emailField() });
type V = z.input<typeof schema>;

function setup(onSubmit: (v: z.output<typeof schema>) => Promise<unknown>) {
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <Form formId="t" schema={schema} defaultValues={{ name: '', email: '' } satisfies V} onSubmit={onSubmit}>
          <TextField<V> name="name" label="Name" autoComplete="name" />
          <TextField<V> name="email" label="Email" autoComplete="email" />
          <SubmitButton>Send</SubmitButton>
        </Form>
      ),
    },
  ]);
  return render(<RouterProvider router={router} />);
}

beforeAll(async () => {
  await initFormsI18n();
});

describe('Form', () => {
  it('validates on blur, links the error with aria-describedby, and goes live afterwards', async () => {
    const u = userEvent.setup();
    setup(async () => undefined);
    const email = screen.getByLabelText('Email');
    await u.type(email, 'a@b');
    await u.tab();
    const msg = await screen.findByText(/looks incomplete/i);
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email.getAttribute('aria-describedby')).toContain(msg.id);
    await u.type(email, '.com');
    await waitFor(() => expect(email).not.toHaveAttribute('aria-invalid', 'true'));
  });

  it('focuses the first invalid field on submit', async () => {
    const u = userEvent.setup();
    setup(async () => undefined);
    await u.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
  });

  it('double click submits once and disables the button while in flight', async () => {
    const u = userEvent.setup();
    let release: () => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((r) => { release = r; }));
    setup(onSubmit);
    await u.type(screen.getByLabelText('Name'), 'Ann');
    await u.type(screen.getByLabelText('Email'), 'ann@x.com');
    const btn = screen.getByRole('button', { name: 'Send' });
    await u.dblClick(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(btn).not.toBeDisabled());
  });
});

describe('masked field', () => {
  it('formats a phone as you type and stores canonical text', async () => {
    const u = userEvent.setup();
    const s2 = z.object({ phone: z.string() });
    type P = z.input<typeof s2>;
    const router = createMemoryRouter([{ path: '/', element: (
      <Form formId="p" schema={s2} defaultValues={{ phone: '' } satisfies P} onSubmit={async () => undefined}>
        <TextField<P> name="phone" label="Phone" mask={phoneMask('US')} autoComplete="tel" />
      </Form>) }]);
    render(<RouterProvider router={router} />);
    const input = screen.getByLabelText('Phone');
    await u.type(input, '2025550123');
    expect(input).toHaveValue('(202) 555-0123');
    expect(input).toHaveAttribute('inputmode', 'tel');
    expect(input).toHaveAttribute('dir', 'ltr');
  });
});
