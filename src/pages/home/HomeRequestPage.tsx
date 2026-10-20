import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Camera, CheckCircle2, X } from 'lucide-react';
import { useHomeowner } from '@/contexts/HomeownerAuthContext';
import { submitServiceRequest } from '@/lib/homeowner/api';
import { PHOTO_MAX_COUNT, SERVICE_TYPES, validatePhotoFile } from '@/lib/homeowner/format';
import { Card, cx, ErrorNote, PrimaryButton, SecondaryButton } from './ui';

export function HomeRequestPage() {
  const { overview, userId } = useHomeowner();
  const [params] = useSearchParams();
  const options = (overview?.businesses ?? []).filter((b) => b.live);
  const [linkId, setLinkId] = useState(params.get('link') ?? '');
  const [serviceType, setServiceType] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!linkId && options.length === 1) setLinkId(options[0].link_id);
  }, [linkId, options]);

  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    for (const f of incoming) {
      const problem = validatePhotoFile(f);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setError(null);
    setFiles((cur) => [...cur, ...incoming].slice(0, PHOTO_MAX_COUNT));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId || !linkId) return;
    if (!serviceType && !message.trim()) {
      setError('Tell us a little about what you need.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submitServiceRequest({ linkId, userId, serviceType, message, files });
      setDone(true);
      setFiles([]);
      setMessage('');
      setServiceType('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send your request.');
    } finally {
      setBusy(false);
    }
  };

  if (options.length === 0) {
    return (
      <Card>
        <p className="text-sm text-text-secondary">Connect a provider first, then you can send them service requests with photos.</p>
        <Link to="/home/businesses" className="focus-ring mt-2 inline-block text-sm font-semibold text-accent">Go to Providers</Link>
      </Card>
    );
  }

  if (done) {
    return (
      <Card className="space-y-3 text-center">
        <CheckCircle2 size={40} className="mx-auto text-success" aria-hidden />
        <h1 className="text-lg font-semibold text-text-primary">Request sent</h1>
        <p className="text-sm text-text-secondary">The business will contact you using the details they have on file.</p>
        <SecondaryButton onClick={() => setDone(false)}>Send another</SecondaryButton>
      </Card>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <header>
        <h1 className="text-2xl font-semibold text-text-primary">Request service</h1>
        <p className="text-sm text-text-secondary">Your message and photos are sent to the provider you choose — nobody else.</p>
      </header>

      <div>
        <label htmlFor="req-provider" className="mb-1 block text-sm font-medium text-text-primary">Provider</label>
        <select
          id="req-provider"
          value={linkId}
          onChange={(e) => setLinkId(e.target.value)}
          className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-3 text-sm text-text-primary"
        >
          <option value="" disabled>Choose a provider</option>
          {options.map((b) => <option key={b.link_id} value={b.link_id}>{b.business_name}</option>)}
        </select>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-text-primary">What do you need?</legend>
        <div className="flex flex-wrap gap-2">
          {SERVICE_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={serviceType === t}
              onClick={() => setServiceType((cur) => (cur === t ? '' : t))}
              className={cx(
                'focus-ring min-h-[40px] rounded-full px-4 text-sm font-medium',
                serviceType === t ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="req-message" className="mb-1 block text-sm font-medium text-text-primary">Describe the problem</label>
        <textarea
          id="req-message"
          rows={4}
          maxLength={2000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What’s happening, since when, and anything you’ve already tried."
          className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-3 text-sm text-text-primary"
        />
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-text-primary">Photos ({files.length}/{PHOTO_MAX_COUNT})</p>
        <div className="flex flex-wrap gap-3">
          {previews.map((src, i) => (
            <div key={src} className="relative h-20 w-20 overflow-hidden rounded-xl border border-border">
              <img src={src} alt={`Attached photo ${i + 1}`} className="h-full w-full object-cover" />
              <button
                type="button"
                aria-label={`Remove photo ${i + 1}`}
                onClick={() => setFiles((cur) => cur.filter((_, idx) => idx !== i))}
                className="focus-ring absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ))}
          {files.length < PHOTO_MAX_COUNT && (
            <label className="focus-within:ring-2 focus-within:ring-accent flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border text-xs text-text-secondary">
              <Camera size={20} aria-hidden />
              Add
              <input
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
      </div>

      {error && <ErrorNote message={error} />}
      <PrimaryButton type="submit" busy={busy} disabled={!linkId} className="w-full">Send request</PrimaryButton>
    </form>
  );
}
