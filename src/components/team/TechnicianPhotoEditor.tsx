import { useRef, useState, type ChangeEvent } from 'react';
import { Camera } from 'lucide-react';
import { supabase, type TeamMember } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';

const BUCKET = 'technician-photos';
const MAX_BYTES = 2 * 1024 * 1024;
const EXT_BY_TYPE: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function storagePathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = `/${BUCKET}/`;
  const i = url.indexOf(marker);
  return i === -1 ? null : decodeURIComponent(url.slice(i + marker.length).split('?')[0] ?? '');
}

export function TechnicianPhotoEditor({
  member,
  name,
  onChanged,
}: {
  member: TeamMember;
  name: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [broken, setBroken] = useState(false);
  const photo = member.photo_url && !broken ? member.photo_url : null;

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const ext = EXT_BY_TYPE[file.type];
    if (!ext) {
      toast('Use a JPG, PNG or WebP photo.', 'error');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast('Photo must be under 2 MB.', 'error');
      return;
    }
    setBusy(true);
    try {
      const path = `${member.account_owner_id}/${member.id}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { contentType: file.type, cacheControl: '31536000' });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
      const { error } = await supabase.from('team_members').update({ photo_url: data.publicUrl }).eq('id', member.id);
      if (error) throw error;
      const old = storagePathFromUrl(member.photo_url);
      if (old) void supabase.storage.from(BUCKET).remove([old]);
      setBroken(false);
      toast('Photo updated.', 'success');
      onChanged();
    } catch {
      toast('Could not upload the photo. Please try again.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative shrink-0">
      {photo ? (
        <img
          src={photo}
          alt={`Photo of ${name}`}
          width={56}
          height={56}
          onError={() => setBroken(true)}
          className="h-14 w-14 rounded-full object-cover"
        />
      ) : (
        <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-full bg-bg-tertiary text-xl font-semibold text-text-secondary">
          {name[0]?.toUpperCase()}
        </span>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        aria-label={`Change photo of ${name}`}
        className="focus-ring absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-bg-secondary text-text-secondary hover:text-text-primary disabled:opacity-50"
      >
        <Camera size={12} />
      </button>
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={onPick} />
    </div>
  );
}
