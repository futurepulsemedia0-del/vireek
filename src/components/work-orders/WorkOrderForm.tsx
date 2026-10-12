import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import {
  APPROVAL_OPTIONS,
  validateWorkOrderForm,
  type FormErrors,
  type WorkOrderFormValues,
} from '@/lib/workOrders';
import type { CustomerOption } from '@/lib/workOrdersApi';

// ============================================================
// Shared native <select> that matches <Input /> (used by the visit form too)
// ============================================================

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  error?: string;
  helperText?: string;
  disabled?: boolean;
}

export function SelectField({ label, value, onChange, options, placeholder, error, helperText, disabled }: SelectFieldProps) {
  const id = useId();
  const describedBy = error || helperText ? `${id}-description` : undefined;
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
        className={`focus-ring w-full rounded-xl border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${
          error ? 'border-danger' : 'border-border'
        }`}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {(error || helperText) && (
        <p
          id={`${id}-description`}
          role={error ? 'alert' : undefined}
          className={`mt-1.5 text-xs ${error ? 'text-danger' : 'text-text-secondary'}`}
        >
          {error || helperText}
        </p>
      )}
    </div>
  );
}

// ============================================================
// Work order form (create + edit)
// ============================================================

interface WorkOrderFormProps {
  initial: WorkOrderFormValues;
  customers: CustomerOption[];
  isEdit: boolean;
  saving: boolean;
  serverError: string | null;
  onSubmit: (values: WorkOrderFormValues) => void;
  onCancel: () => void;
}

export function WorkOrderForm({ initial, customers, isEdit, saving, serverError, onSubmit, onCancel }: WorkOrderFormProps) {
  const [values, setValues] = useState<WorkOrderFormValues>(initial);
  const [errors, setErrors] = useState<FormErrors<WorkOrderFormValues>>({});

  const set = <K extends keyof WorkOrderFormValues>(key: K, value: WorkOrderFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const handleCustomer = (customerId: string) => {
    const customer = customers.find((c) => c.id === customerId);
    setValues((prev) => ({
      ...prev,
      customer_id: customerId,
      // Convenience only: never overwrite what the dispatcher already typed.
      site_address: prev.site_address.trim() || !customer?.address ? prev.site_address : customer.address,
    }));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const found = validateWorkOrderForm(values);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(values);
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={isEdit ? 'Edit work order' : 'New work order'}
      className="space-y-6 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-6"
    >
      <div>
        <h2 className="text-lg font-semibold text-text-primary">{isEdit ? 'Edit work order' : 'New work order'}</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Capture the customer&apos;s PO, the site, and who to call there. Add visits after saving.
        </p>
      </div>

      <fieldset className="space-y-4" disabled={saving}>
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">Order</legend>
        <Input
          label="Title"
          required
          value={values.title}
          error={errors.title}
          maxLength={200}
          placeholder="Rooftop unit #3 compressor replacement"
          onChange={(e) => set('title', e.target.value)}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Customer"
            value={values.customer_id}
            onChange={handleCustomer}
            placeholder="No customer linked"
            options={customers.map((c) => ({ value: c.id, label: c.name }))}
            helperText={customers.length === 0 ? 'Only commercial customers appear here.' : undefined}
          />
          <Input
            label="PO number"
            value={values.po_number}
            error={errors.po_number}
            maxLength={60}
            placeholder="PO-48213"
            onChange={(e) => set('po_number', e.target.value)}
          />
          <Input
            label="Work order number"
            value={values.work_order_number}
            error={errors.work_order_number}
            maxLength={40}
            helperText={isEdit ? undefined : 'Leave blank to auto-number (WO-00001).'}
            onChange={(e) => set('work_order_number', e.target.value)}
          />
          <Input
            label="Not-to-exceed amount"
            inputMode="decimal"
            value={values.not_to_exceed}
            error={errors.not_to_exceed}
            placeholder="5000"
            helperText="Visit billing can never go above this cap."
            onChange={(e) => set('not_to_exceed', e.target.value)}
          />
        </div>
        <SelectField
          label="Approval"
          value={values.approval_status}
          onChange={(v) => set('approval_status', v as WorkOrderFormValues['approval_status'])}
          options={APPROVAL_OPTIONS}
          helperText="Work can only start once this is Approved or No approval needed."
        />
        <Textarea
          label="Scope of work"
          rows={3}
          value={values.description}
          error={errors.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </fieldset>

      <fieldset className="space-y-4" disabled={saving}>
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">Site & contact</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Site name" value={values.site_name} onChange={(e) => set('site_name', e.target.value)} />
          <Input label="Site address" value={values.site_address} onChange={(e) => set('site_address', e.target.value)} />
          <Input
            label="Site contact"
            autoComplete="off"
            value={values.site_contact_name}
            onChange={(e) => set('site_contact_name', e.target.value)}
          />
          <Input
            label="Contact phone"
            type="tel"
            autoComplete="off"
            value={values.site_contact_phone}
            error={errors.site_contact_phone}
            onChange={(e) => set('site_contact_phone', e.target.value)}
          />
          <Input
            label="Contact email"
            type="email"
            autoComplete="off"
            value={values.site_contact_email}
            error={errors.site_contact_email}
            onChange={(e) => set('site_contact_email', e.target.value)}
          />
        </div>
      </fieldset>

      {serverError && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {serverError}
        </p>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving} className="w-full sm:w-auto">
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving} className="w-full sm:w-auto">
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create work order'}
        </Button>
      </div>
    </form>
  );
}
