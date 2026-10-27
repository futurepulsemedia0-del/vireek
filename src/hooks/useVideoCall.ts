import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VideoCallEngine, type EngineSnapshot, type RecordedClip } from '@/lib/videoCallEngine';
import {
  LIMITS,
  clipStoragePath,
  friendlyVideoError,
  isJoinable,
  isValidToken,
  recordGate,
  validateDisplayName,
  type JoinResult,
  type PublicSession,
  type VideoClipRow,
} from '@/lib/videoSession';
import { endVideoSession, fetchIceServers, getPublicSession, joinVideoSession, sendHeartbeat, uploadClip } from '@/lib/videoSessionApi';

export type LoadState = 'loading' | 'ready' | 'missing' | 'error';
export type Stage = 'lobby' | 'joining' | 'call' | 'ended';
export type ClipState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'saved'; clip: VideoClipRow }
  | { status: 'error'; message: string };

const EMPTY: EngineSnapshot = {
  phase: 'idle',
  localStream: null,
  remoteStream: null,
  micOn: true,
  cameraOn: true,
  hasMic: false,
  hasCamera: false,
  canFlip: false,
  remoteName: null,
  quality: 'unknown',
  relayed: false,
  recording: 'idle',
  recordingSeconds: 0,
  remoteRecording: false,
  recordError: null,
  mediaIssue: null,
  signalingOk: true,
};

/** Orchestrates one call: session lookup, device preview, join, signaling, heartbeat and clip upload. */
export function useVideoCall(token: string | undefined) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [session, setSession] = useState<PublicSession | null>(null);
  const [stage, setStage] = useState<Stage>('lobby');
  const [snap, setSnap] = useState<EngineSnapshot>(EMPTY);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joined, setJoined] = useState<JoinResult | null>(null);
  const [relay, setRelay] = useState(true);
  const [clip, setClip] = useState<ClipState>({ status: 'idle' });
  const [savedCount, setSavedCount] = useState(0);
  const engineRef = useRef<VideoCallEngine | null>(null);
  const pendingClip = useRef<RecordedClip | null>(null);
  const sessionRef = useRef<PublicSession | null>(null);
  sessionRef.current = session;

  const upload = useCallback(async (recorded: RecordedClip) => {
    const s = sessionRef.current;
    if (!s?.owner_id) {
      setClip({ status: 'error', message: 'Sign in as the technician to save clips.' });
      return;
    }
    pendingClip.current = recorded;
    setClip({ status: 'uploading' });
    try {
      const saved = await uploadClip({
        path: clipStoragePath(s.owner_id, s.id, crypto.randomUUID(), recorded.ext),
        blob: recorded.blob,
        mime: recorded.mime,
        sessionId: s.id,
        durationSeconds: recorded.durationSeconds,
      });
      pendingClip.current = null;
      setSavedCount((n) => n + 1);
      setClip({ status: 'saved', clip: saved });
    } catch (err) {
      setClip({ status: 'error', message: friendlyVideoError(err, 'The clip could not be saved. Your copy is still here.') });
    }
  }, []);

  // 1. Look the session up, then open the camera preview (lobby).
  useEffect(() => {
    if (!token || !isValidToken(token)) {
      setLoadState('missing');
      return;
    }
    let cancelled = false;
    setLoadState('loading');
    getPublicSession(token)
      .then((s) => {
        if (cancelled) return;
        if (!s) return setLoadState('missing');
        setSession(s);
        setLoadState('ready');
        if (isJoinable(s.status)) {
          const engine = new VideoCallEngine({ token, role: s.role, onChange: setSnap, onClip: (c) => void upload(c) });
          engineRef.current = engine;
          void engine.prepare();
        } else if (s.status === 'ended') {
          setStage('ended');
        }
      })
      .catch(() => !cancelled && setLoadState('error'));
    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [token, upload]);

  // 2. Heartbeat while joined; the server tells us if the session ended behind our back.
  useEffect(() => {
    if (stage !== 'call' || !token) return;
    const id = setInterval(() => {
      sendHeartbeat(token)
        .then((status) => {
          if (status === 'ended' || status === 'cancelled') setStage('ended');
        })
        .catch(() => undefined);
    }, LIMITS.HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [stage, token]);

  // 3. The technician ended it (bye) or the connection died for good.
  useEffect(() => {
    if (snap.phase === 'ended' && stage === 'call') setStage('ended');
  }, [snap.phase, stage]);

  // 4. Leave cleanly when the tab closes.
  useEffect(() => {
    const onHide = () => engineRef.current?.destroy();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  const join = useCallback(
    async (displayName: string, consentRecording: boolean) => {
      const engine = engineRef.current;
      if (!token || !engine || !sessionRef.current) return;
      setJoinError(null);
      if (sessionRef.current.role === 'expert') {
        const nameError = validateDisplayName(displayName);
        if (nameError) return setJoinError(nameError);
      }
      setStage('joining');
      try {
        const [result, ice] = await Promise.all([joinVideoSession(token, displayName, consentRecording), fetchIceServers(token)]);
        setJoined(result);
        setRelay(ice.relay);
        const name = result.role === 'technician' ? sessionRef.current.technician_name ?? 'Technician' : displayName.trim();
        await engine.connect({ iceServers: ice.iceServers, displayName: name, relay: ice.relay });
        setStage('call');
      } catch (err) {
        setStage('lobby');
        setJoinError(friendlyVideoError(err));
        void getPublicSession(token).then((s) => s && setSession(s)).catch(() => undefined);
      }
    },
    [token],
  );

  const endSession = useCallback(async () => {
    if (!token) return;
    const engine = engineRef.current;
    try {
      await endVideoSession(token);
    } catch (err) {
      setJoinError(friendlyVideoError(err));
    }
    engine?.endForAll();
    setStage('ended');
  }, [token]);

  const leave = useCallback(() => {
    engineRef.current?.destroy();
    setStage('ended');
  }, []);

  const gate = useMemo(
    () =>
      recordGate({
        role: session?.role ?? 'expert',
        recordingAllowed: session?.recording_allowed ?? false,
        expertConsented: joined?.expert_consented ?? session?.expert_consented ?? false,
        connected: snap.phase === 'connected',
        hasLocalVideo: snap.hasCamera,
        recorderSupported: VideoCallEngine.recorderSupported(),
      }),
    [session, joined, snap.phase, snap.hasCamera],
  );

  const retryUpload = useCallback(() => {
    if (pendingClip.current) void upload(pendingClip.current);
  }, [upload]);

  return {
    loadState,
    session,
    stage,
    snap,
    joined,
    joinError,
    relay,
    clip,
    savedCount,
    recordGate: gate,
    join,
    endSession,
    leave,
    retryUpload,
    pendingClip: pendingClip.current,
    dismissClip: () => {
      pendingClip.current = null;
      setClip({ status: 'idle' });
    },
    retryLoad: () => window.location.reload(),
    setMic: (on: boolean) => engineRef.current?.setMic(on),
    setCamera: (on: boolean) => engineRef.current?.setCamera(on),
    flipCamera: () => void engineRef.current?.flipCamera(),
    startRecording: () => engineRef.current?.startRecording(),
    stopRecording: () => engineRef.current?.stopRecording(),
  };
}
