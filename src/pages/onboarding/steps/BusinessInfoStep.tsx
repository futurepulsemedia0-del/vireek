import { Building2, MapPin, Wrench } from 'lucide-react';
import { useState } from 'react';
import { StepShell } from '../StepShell';
import { inputClass, chipClass, SERVICE_SUGGESTIONS, type StepProps } from '../types';

export function BusinessInfoStep({ data, update, onNext, onSkip, saving }: StepProps) {
  const [customService, setCustomService] = useState('');

  const toggleService = (svc: string) => {
    update({
      services: data.services.includes(svc)
        ? data.services.filter((s) => s !== svc)
        : [...data.services, svc],
    });
  };

  const addCustomService = () => {
    const trimmed = customService.trim();
    if (trimmed && !data.services.includes(trimmed)) {
      update({ services: [...data.services, trimmed] });
    }
    setCustomService('');
  };

  const canProceed = !!(data.fullName.trim() && data.companyName.trim());

  return (
    <StepShell
      stepKey="business"
      icon={Building2}
      title="Tell Sarah about your business"
      description="This helps Sarah answer calls accurately. You can change everything later."
      onNext={onNext}
      onSkip={onSkip}
      nextDisabled={!canProceed}
      saving={saving}
    >
      <div className="grid gap-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-text-primary">
            Full Name <span className="text-cta">*</span>
          </label>
          <input
            type="text"
            autoComplete="name"
            value={data.fullName}
            onChange={(e) => update({ fullName: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-text-primary">
            Company Name <span className="text-cta">*</span>
          </label>
          <input
            type="text"
            autoComplete="organization"
            value={data.companyName}
            onChange={(e) => update({ companyName: e.target.value })}
            className={inputClass}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">Phone Number</label>
            <input
              type="tel"
              autoComplete="tel"
              value={data.phone}
              onChange={(e) => update({ phone: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">Forwarding Number</label>
            <input
              type="tel"
              placeholder="Number to forward to Sarah"
              value={data.forwardingNumber}
              onChange={(e) => update({ forwardingNumber: e.target.value })}
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text-primary">
            <Wrench size={14} className="text-accent" /> Services You Offer
          </label>
          <div className="flex flex-wrap gap-2">
            {SERVICE_SUGGESTIONS.map((svc) => (
              <button key={svc} type="button" onClick={() => toggleService(svc)} className={chipClass(data.services.includes(svc))}>
                {svc}
              </button>
            ))}
            {data.services
              .filter((s) => !SERVICE_SUGGESTIONS.includes(s))
              .map((svc) => (
                <button key={svc} type="button" onClick={() => toggleService(svc)} className={chipClass(true)}>
                  {svc}
                </button>
              ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={customService}
              onChange={(e) => setCustomService(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustomService();
                }
              }}
              placeholder="Add a custom service…"
              className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60"
            />
            <button
              type="button"
              onClick={addCustomService}
              className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:border-accent/40"
            >
              Add
            </button>
          </div>
        </div>

        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-text-primary">
            <MapPin size={14} className="text-accent" /> Service Area
          </label>
          <input
            type="text"
            placeholder="e.g. Greater Austin, TX"
            value={data.serviceArea}
            onChange={(e) => update({ serviceArea: e.target.value })}
            className={inputClass}
          />
        </div>
      </div>
    </StepShell>
  );
}
