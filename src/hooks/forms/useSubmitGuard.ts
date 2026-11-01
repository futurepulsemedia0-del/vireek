import { useEffect, useMemo, useRef, useState } from 'react';
import { createSubmitGuard, type SubmitContext, type SubmitGuardOptions } from '@/lib/forms/submitGuard';

/** React wrapper around createSubmitGuard: stable `run`, reactive `submitting`. */
export function useSubmitGuard<TArgs, TResult>(
  fn: (args: TArgs, ctx: SubmitContext) => Promise<TResult>,
  options: Omit<SubmitGuardOptions, 'onSubmittingChange'> = {},
) {
  const [submitting, setSubmitting] = useState(false);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const optionsRef = useRef(options);
  const guard = useMemo(
    () =>
      createSubmitGuard<TArgs, TResult>((args, ctx) => fnRef.current(args, ctx), {
        ...optionsRef.current,
        onSubmittingChange: setSubmitting,
      }),
    [],
  );
  return { run: guard.run, submitting, abort: guard.abort };
}
