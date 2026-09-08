/**
 * Vireek — OTP Verification Demo
 *
 * A self-playing, interactive "how our 2FA feels" widget for marketing pages
 * (Security page, live-demo sections, etc.). It is NOT wired to real auth —
 * real sign-in/2FA lives in SecuritySettingsPage.tsx via supabase.auth.mfa.
 * This is a scoped, dependency-free port of the original vanilla script:
 * same timing/animation logic, but initialized against a passed-in root
 * element (instead of `document.querySelector`) and fully torn down on
 * cleanup, so it's safe to mount/unmount from React (Fast Refresh, route
 * changes, etc.) without leaking timers, rAF loops, or listeners.
 */

const CODE_OK = '204815';
const CODE_NO = '061947';
const RESUME_MS = 5200;

type ScriptStep = { t: number; fn: () => void; end?: boolean };

export function initOtpVerifyDemo(root: HTMLElement): () => void {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('.vrk-otp-input'));
  const boxes = inputs.map((inp) => inp.parentElement as HTMLElement);
  const N = inputs.length;
  if (!N) return () => {};

  const statusEl = root.querySelector<HTMLElement>('.vrk-otp-status');
  const statusText = root.querySelector<HTMLElement>('.vrk-otp-status-text');
  const form = root.querySelector<HTMLFormElement>('.vrk-otp-form');
  if (!statusEl || !statusText || !form) return () => {};

  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : ({ matches: false } as MediaQueryList);
  let reduce = !!mq.matches;

  const controller = new AbortController();
  const { signal } = controller;

  let destroyed = false;
  let rafId = 0;
  const raf = (fn: FrameRequestCallback) => window.requestAnimationFrame(fn);

  /* ---------- helpers ---------- */
  function setStatus(text: string, state?: 'ok' | 'err' | '') {
    statusText!.textContent = text;
    statusEl!.className = 'vrk-otp-status' + (state ? ' vrk-otp-status--' + state : '');
  }
  function clearActive() {
    for (let i = 0; i < N; i++) boxes[i].classList.remove('vrk-otp-box--active');
  }
  function setActive(i: number) {
    clearActive();
    if (i >= 0 && i < N) boxes[i].classList.add('vrk-otp-box--active');
  }
  function popBox(i: number) {
    const b = boxes[i];
    b.classList.remove('vrk-otp-box--tap');
    void b.offsetWidth;
    b.classList.add('vrk-otp-box--tap');
  }
  function fillDigit(i: number, ch: string, pop: boolean) {
    inputs[i].value = ch;
    boxes[i].classList.add('vrk-otp-box--filled');
    if (pop) popBox(i);
  }
  function allFilled() {
    for (let i = 0; i < N; i++) if (inputs[i].value.length !== 1) return false;
    return true;
  }
  function resetBoxes() {
    root.classList.remove('vrk-otp-success', 'vrk-otp-shake');
    clearActive();
    for (let i = 0; i < N; i++) {
      inputs[i].value = '';
      boxes[i].classList.remove('vrk-otp-box--filled', 'vrk-otp-box--tap');
    }
  }
  function success(demo: boolean) {
    root.classList.remove('vrk-otp-shake');
    root.classList.add('vrk-otp-success');
    clearActive();
    for (let i = 0; i < N; i++) boxes[i].classList.add('vrk-otp-box--filled');
    setStatus('Code verified', 'ok');
    if (!demo && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }
  function wrong() {
    root.classList.remove('vrk-otp-success');
    root.classList.add('vrk-otp-shake');
    clearActive();
    for (let i = 0; i < N; i++) boxes[i].classList.add('vrk-otp-box--filled');
    setStatus(`Incorrect code — try ${CODE_OK}`, 'err');
  }

  /* ---------- real-visitor verification: fixed demo code = success ---------- */
  let wrongTimer = 0;
  function verifyUser() {
    let typed = '';
    for (let vi = 0; vi < N; vi++) typed += inputs[vi].value;
    if (typed === CODE_OK) {
      success(false);
      return;
    }
    wrong();
    lastInteract = performance.now();
    if (wrongTimer) window.clearTimeout(wrongTimer);
    wrongTimer = window.setTimeout(() => {
      wrongTimer = 0;
      if (!userActive || destroyed) return;
      resetBoxes();
      setStatus('Enter the 6-digit code', '');
      lastInteract = performance.now();
      try {
        inputs[0].focus();
      } catch {
        /* noop */
      }
    }, 1500);
  }

  /* ---------- real interaction ---------- */
  let userActive = false;
  let lastInteract = 0;

  function goUser(reset: boolean) {
    if (wrongTimer) {
      window.clearTimeout(wrongTimer);
      wrongTimer = 0;
    }
    if (!userActive && reset) resetBoxes();
    userActive = true;
    lastInteract = performance.now();
    clearActive();
  }

  inputs.forEach((inp, idx) => {
    inp.addEventListener('pointerdown', () => goUser(true), { signal });
    inp.addEventListener('focus', () => goUser(true), { signal });

    inp.addEventListener(
      'input',
      () => {
        goUser(false);
        const v = inp.value.replace(/[^0-9]/g, '');
        inp.value = v.slice(-1);
        if (inp.value) {
          boxes[idx].classList.add('vrk-otp-box--filled');
          popBox(idx);
          if (idx < N - 1) {
            inputs[idx + 1].focus();
            try {
              inputs[idx + 1].select();
            } catch {
              /* noop */
            }
          }
        } else {
          boxes[idx].classList.remove('vrk-otp-box--filled');
        }
        root.classList.remove('vrk-otp-shake');
        if (allFilled()) verifyUser();
      },
      { signal },
    );

    inp.addEventListener(
      'keydown',
      (e) => {
        goUser(false);
        const k = e.key;
        if (k === 'Backspace') {
          if (!inp.value && idx > 0) {
            e.preventDefault();
            inputs[idx - 1].focus();
            inputs[idx - 1].value = '';
            boxes[idx - 1].classList.remove('vrk-otp-box--filled');
          } else if (inp.value) {
            inp.value = '';
            boxes[idx].classList.remove('vrk-otp-box--filled');
          }
          root.classList.remove('vrk-otp-success', 'vrk-otp-shake');
        } else if (k === 'ArrowLeft') {
          if (idx > 0) {
            e.preventDefault();
            inputs[idx - 1].focus();
          }
        } else if (k === 'ArrowRight') {
          if (idx < N - 1) {
            e.preventDefault();
            inputs[idx + 1].focus();
          }
        } else if (k === 'Home') {
          e.preventDefault();
          inputs[0].focus();
        } else if (k === 'End') {
          e.preventDefault();
          inputs[N - 1].focus();
        }
      },
      { signal },
    );

    inp.addEventListener(
      'paste',
      (e) => {
        e.preventDefault();
        goUser(true);
        const data = e.clipboardData;
        const text = data ? data.getData('text') : '';
        const digits = (text || '').replace(/[^0-9]/g, '').slice(0, N).split('');
        if (!digits.length) return;
        root.classList.remove('vrk-otp-success', 'vrk-otp-shake');
        for (let i = 0; i < N; i++) {
          if (digits[i]) {
            fillDigit(i, digits[i], true);
          } else {
            inputs[i].value = '';
            boxes[i].classList.remove('vrk-otp-box--filled');
          }
        }
        const next = Math.min(digits.length, N - 1);
        inputs[next].focus();
        if (allFilled()) verifyUser();
      },
      { signal },
    );
  });

  form.addEventListener(
    'submit',
    (e) => {
      e.preventDefault();
      goUser(false);
      if (allFilled()) verifyUser();
    },
    { signal },
  );

  /* ---------- idle self-demo ---------- */
  let script: ScriptStep[] = [];
  let sIdx = 0;
  let timeline = 0;
  let cycle = 0;
  let prevNow = performance.now();

  function buildScript() {
    script = [];
    timeline = 0;
    sIdx = 0;
    const good = cycle % 2 === 0;
    const code = good ? CODE_OK : CODE_NO;

    script.push({
      t: 0,
      fn: () => {
        resetBoxes();
        setStatus('Enter the 6-digit code', '');
      },
    });

    let t = 460;
    for (let i = 0; i < N; i++) {
      const at = t;
      script.push({ t: at, fn: () => setActive(i) });
      script.push({ t: at + 130, fn: () => fillDigit(i, code.charAt(i), true) });
      t += 300;
    }
    script.push({ t: t + 120, fn: () => clearActive() });
    t += 520;

    if (good) {
      script.push({ t, fn: () => success(true) });
      t += 2200;
    } else {
      script.push({ t, fn: () => wrong() });
      t += 1600;
    }
    script.push({ t: t + 620, end: true, fn: () => {} });
  }

  function frame(now: number) {
    if (destroyed) return;
    const p = now;
    let dt = p - prevNow;
    if (dt < 0) dt = 0;
    if (dt > 80) dt = 80;
    prevNow = p;

    if (userActive) {
      if (p - lastInteract > RESUME_MS) {
        userActive = false;
        if (reduce) {
          resetBoxes();
          setActive(0);
          setStatus('Enter the 6-digit code', '');
        } else {
          cycle++;
          buildScript();
        }
      }
    } else if (!reduce) {
      timeline += dt;
      while (sIdx < script.length && script[sIdx].t <= timeline) {
        const step = script[sIdx++];
        try {
          step.fn();
        } catch {
          /* noop */
        }
        if (step.end) {
          cycle++;
          buildScript();
          break;
        }
      }
    }
    rafId = raf(frame);
  }

  // stagger index for CSS transition-delay (--votp-i)
  boxes.forEach((b, i) => b.style.setProperty('--votp-i', String(i)));

  buildScript();
  if (reduce) {
    resetBoxes();
    setActive(0);
    setStatus('Enter the 6-digit code', '');
  }
  prevNow = performance.now();
  rafId = raf(frame);

  const onMqChange = (e: MediaQueryListEvent) => {
    reduce = !!e.matches;
    if (reduce) {
      resetBoxes();
      setActive(0);
      setStatus('Enter the 6-digit code', '');
    } else {
      cycle++;
      buildScript();
    }
  };
  mq.addEventListener?.('change', onMqChange);

  return function destroy() {
    destroyed = true;
    controller.abort();
    if (wrongTimer) window.clearTimeout(wrongTimer);
    if (rafId) window.cancelAnimationFrame(rafId);
    mq.removeEventListener?.('change', onMqChange);
  };
}
