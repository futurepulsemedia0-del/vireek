import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_ATTACHMENTS,
  buildSubmission,
  clearDraft,
  hasBlockingErrors,
  loadDraft,
  newSubmissionRef,
  saveDraft,
  validateSubmission,
  visibleFields,
} from '@/lib/offline/formLogic';
import type { BuiltSubmission, FormAttachments, FormValue, FormValues, SignatureAttachment } from '@/lib/offline/formLogic';
import type { FormField, FormTemplate } from '@/lib/offline/formSchema';

let photoCounter = 0;

/**
 * State for filling in ONE form. Used by the technician's offline panel and by the builder's
 * live preview, so both behave identically. Text answers can be persisted as a draft (so a
 * reload or a dropped signal never loses typing); photos and signatures live in memory until
 * the form is submitted into the offline outbox.
 */
export function useFormSession(template: FormTemplate | null, draftKey: string | null) {
  const [values, setValues] = useState<FormValues>({});
  const [attachments, setAttachments] = useState<FormAttachments>(EMPTY_ATTACHMENTS);
  const [attempted, setAttempted] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const submissionRef = useRef(newSubmissionRef());

  const templateId = template?.id ?? null;

  // Switching template (or job) starts a fresh session, restoring a saved draft if one exists.
  useEffect(() => {
    const draft = draftKey ? loadDraft(draftKey) : {};
    setValues(draft);
    setDraftRestored(Object.keys(draft).length > 0);
    setAttachments(EMPTY_ATTACHMENTS);
    setAttempted(false);
    submissionRef.current = newSubmissionRef();
  }, [templateId, draftKey]);

  // Debounced draft persistence.
  useEffect(() => {
    if (!draftKey) return undefined;
    const t = window.setTimeout(() => saveDraft(draftKey, values), 400);
    return () => window.clearTimeout(t);
  }, [values, draftKey]);

  const validation = useMemo(
    () => (template ? validateSubmission(template, values, attachments) : { errors: {}, warnings: {} }),
    [template, values, attachments]
  );

  const visible: FormField[] = useMemo(() => (template ? visibleFields(template, values) : []), [template, values]);

  const setValue = useCallback((id: string, value: FormValue) => {
    setValues((prev) => ({ ...prev, [id]: value }));
  }, []);

  const addPhotos = useCallback((fieldId: string, blobs: Blob[]) => {
    setAttachments((prev) => ({
      ...prev,
      photos: {
        ...prev.photos,
        [fieldId]: [...(prev.photos[fieldId] ?? []), ...blobs.map((blob) => ({ id: `p${(photoCounter += 1)}`, blob }))],
      },
    }));
  }, []);

  const removePhoto = useCallback((fieldId: string, photoId: string) => {
    setAttachments((prev) => ({
      ...prev,
      photos: { ...prev.photos, [fieldId]: (prev.photos[fieldId] ?? []).filter((p) => p.id !== photoId) },
    }));
  }, []);

  const setSignature = useCallback((fieldId: string, signature: SignatureAttachment | undefined) => {
    setAttachments((prev) => ({ ...prev, signatures: { ...prev.signatures, [fieldId]: signature } }));
  }, []);

  /** Marks the form as submitted-once (so errors show) and reports whether it can be sent. */
  const validate = useCallback((): boolean => {
    setAttempted(true);
    return !hasBlockingErrors(validation);
  }, [validation]);

  const build = useCallback((): BuiltSubmission | null => {
    if (!template) return null;
    return buildSubmission(template, values, attachments, submissionRef.current);
  }, [template, values, attachments]);

  /** Clears everything after a successful save (and starts a new submission ref). */
  const reset = useCallback(() => {
    if (draftKey) clearDraft(draftKey);
    setValues({});
    setAttachments(EMPTY_ATTACHMENTS);
    setAttempted(false);
    setDraftRestored(false);
    submissionRef.current = newSubmissionRef();
  }, [draftKey]);

  return {
    values,
    attachments,
    visible,
    errors: attempted ? validation.errors : ({} as Record<string, string>),
    warnings: validation.warnings,
    attempted,
    draftRestored,
    setValue,
    addPhotos,
    removePhoto,
    setSignature,
    validate,
    build,
    reset,
  };
}

export type FormSession = ReturnType<typeof useFormSession>;
