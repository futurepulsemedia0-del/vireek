/**
 * WebRTC engine for a live video session. Framework-free (the React hook wraps it).
 *
 * Signaling: Supabase Realtime broadcast + presence on a private-by-obscurity topic derived from
 * the 244-bit join token. Media: peer-to-peer (TURN relay when the network needs it).
 * The technician is always the offerer, so there is no offer glare.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import {
  LIMITS,
  assessQuality,
  classifyMediaError,
  parseSignal,
  pickRecorderMime,
  reconnectDelay,
  type CallRole,
  type ConnectionQuality,
  type MediaIssueKind,
  type SignalMessage,
} from '@/lib/videoSession';

export type CallPhase = 'idle' | 'preparing' | 'ready' | 'connecting' | 'waiting' | 'negotiating' | 'connected' | 'reconnecting' | 'failed' | 'ended';

export interface RecordedClip {
  blob: Blob;
  mime: 'video/webm' | 'video/mp4';
  ext: 'webm' | 'mp4';
  durationSeconds: number;
}

export interface EngineSnapshot {
  phase: CallPhase;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  micOn: boolean;
  cameraOn: boolean;
  hasMic: boolean;
  hasCamera: boolean;
  canFlip: boolean;
  remoteName: string | null;
  quality: ConnectionQuality;
  relayed: boolean;
  recording: 'idle' | 'recording';
  recordingSeconds: number;
  remoteRecording: boolean;
  recordError: string | null;
  mediaIssue: { kind: MediaIssueKind; message: string } | null;
  signalingOk: boolean;
}

interface EngineOptions {
  token: string;
  role: CallRole;
  onChange: (s: EngineSnapshot) => void;
  onClip: (clip: RecordedClip) => void;
}

interface PresenceMeta {
  peerId: string;
  role: CallRole;
  name: string;
  joinedAt: number;
}

const randomId = () => `${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

export class VideoCallEngine {
  private readonly peerId = randomId();
  private readonly opts: EngineOptions;

  private channel: RealtimeChannel | null = null;
  private pc: RTCPeerConnection | null = null;
  private iceServers: RTCIceServer[] = [];
  private displayName = '';
  private remoteId: string | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private makingOffer = false;
  private restartAttempts = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastStats: { at: number; bytes: number; lost: number; received: number } | null = null;

  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private facing: 'user' | 'environment';
  private videoDevices = 0;

  private recorder: MediaRecorder | null = null;
  private recChunks: Blob[] = [];
  private recStartedAt = 0;
  private recTimer: ReturnType<typeof setInterval> | null = null;
  private audioCtx: AudioContext | null = null;
  private wakeLock: { release: () => Promise<void> } | null = null;
  private destroyed = false;

  private s: EngineSnapshot = {
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

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.facing = opts.role === 'technician' ? 'environment' : 'user';
  }

  get snapshot(): EngineSnapshot {
    return this.s;
  }

  static recorderSupported(): boolean {
    return typeof MediaRecorder !== 'undefined' && pickRecorderMime((m) => MediaRecorder.isTypeSupported(m)) !== null;
  }

  private set(patch: Partial<EngineSnapshot>) {
    if (this.destroyed) return;
    this.s = { ...this.s, ...patch };
    this.opts.onChange(this.s);
  }

  // ---------------------------------------------------------- media

  /** Asks for camera + microphone, degrading gracefully (audio only, then watch/listen only). */
  async prepare(): Promise<void> {
    this.set({ phase: 'preparing', mediaIssue: null });
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      this.set({ phase: 'ready', mediaIssue: { kind: 'insecure', message: 'Video needs a secure (https) connection.' } });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.set({ phase: 'ready', mediaIssue: { kind: 'unsupported', message: 'This browser does not support video calls. Try Chrome, Safari or Edge.' } });
      return;
    }

    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const video: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
      facingMode: { ideal: this.facing },
    };
    const attempts: MediaStreamConstraints[] = [{ audio, video }, { audio, video: false }, { audio: false, video }];
    let stream: MediaStream | null = null;
    let issue: EngineSnapshot['mediaIssue'] = null;
    for (const c of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(c);
        if (c.video && c.audio) issue = null;
        else issue = { kind: 'other', message: c.audio ? 'Camera unavailable: joining with audio only.' : 'Microphone unavailable: joining without audio.' };
        break;
      } catch (err) {
        issue = classifyMediaError(err);
        if (issue.kind === 'denied') break;
      }
    }
    if (this.destroyed) {
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    this.localStream = stream;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.videoDevices = devices.filter((d) => d.kind === 'videoinput').length;
    } catch {
      this.videoDevices = 0;
    }
    this.set({
      phase: 'ready',
      localStream: stream,
      hasMic: !!stream?.getAudioTracks().length,
      hasCamera: !!stream?.getVideoTracks().length,
      micOn: true,
      cameraOn: true,
      canFlip: this.videoDevices > 1,
      mediaIssue: stream ? (issue && issue.kind !== 'denied' ? issue : null) : issue ?? { kind: 'not-found', message: 'No camera or microphone was found.' },
    });
  }

  setMic(on: boolean) {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = on));
    this.set({ micOn: on });
  }

  setCamera(on: boolean) {
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = on));
    this.set({ cameraOn: on });
  }

  /** Front/back camera. Disabled while recording (the recorder holds the old track). */
  async flipCamera(): Promise<void> {
    if (!this.localStream || this.s.recording === 'recording' || !this.s.canFlip) return;
    const next = this.facing === 'user' ? 'environment' : 'user';
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 }, facingMode: { ideal: next } },
      });
      const track = fresh.getVideoTracks()[0];
      if (!track) return;
      track.enabled = this.s.cameraOn;
      const old = this.localStream.getVideoTracks()[0];
      const sender = this.pc?.getSenders().find((x) => x.track?.kind === 'video');
      if (sender) await sender.replaceTrack(track);
      old?.stop();
      const audioTracks = this.localStream.getAudioTracks();
      this.localStream = new MediaStream([...audioTracks, track]);
      this.facing = next;
      this.set({ localStream: this.localStream });
    } catch {
      /* keep the current camera */
    }
  }

  // ---------------------------------------------------------- connection

  async connect(opts: { iceServers: RTCIceServer[]; displayName: string; relay: boolean }): Promise<void> {
    this.iceServers = opts.iceServers;
    this.displayName = opts.displayName;
    this.set({ phase: 'connecting', relayed: false });
    void this.acquireWakeLock();

    const channel = supabase.channel(`vs:${this.opts.token}`, {
      config: { broadcast: { self: false, ack: false }, presence: { key: this.peerId } },
    });
    this.channel = channel;

    channel
      .on('broadcast', { event: 'sig' }, ({ payload }) => {
        const msg = parseSignal(payload);
        if (msg) void this.onSignal(msg).catch(() => undefined);
      })
      .on('presence', { event: 'sync' }, () => this.syncPeers())
      .subscribe(async (status) => {
        if (this.destroyed) return;
        if (status === 'SUBSCRIBED') {
          this.set({ signalingOk: true });
          const meta: PresenceMeta = { peerId: this.peerId, role: this.opts.role, name: this.displayName, joinedAt: Date.now() };
          await channel.track(meta);
          if (this.s.phase === 'connecting') this.set({ phase: 'waiting' });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.set({ signalingOk: false });
        }
      });
  }

  private pickRemote(): PresenceMeta | null {
    if (!this.channel) return null;
    const state = this.channel.presenceState() as Record<string, PresenceMeta[]>;
    let best: PresenceMeta | null = null;
    for (const [key, metas] of Object.entries(state)) {
      if (key === this.peerId) continue;
      for (const m of metas) {
        if (m.role === this.opts.role || typeof m.peerId !== 'string') continue;
        if (!best || m.joinedAt > best.joinedAt) best = m;
      }
    }
    return best;
  }

  private syncPeers() {
    if (this.destroyed || this.s.phase === 'ended') return;
    const remote = this.pickRemote();
    if (!remote) {
      if (this.remoteId) this.dropRemote();
      return;
    }
    if (remote.peerId === this.remoteId) return;
    this.remoteId = remote.peerId;
    this.closePc();
    this.set({ remoteName: remote.name, phase: 'negotiating', remoteRecording: false });
    if (this.opts.role === 'technician') {
      void this.makeOffer(false);
      if (this.s.recording === 'recording') this.send({ type: 'recording', from: this.peerId, on: true });
    }
  }

  private dropRemote() {
    this.remoteId = null;
    this.closePc();
    this.remoteStream = null;
    this.set({ phase: 'waiting', remoteStream: null, remoteName: null, quality: 'unknown', remoteRecording: false });
  }

  private ensurePc(): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 4, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    this.remoteStream = new MediaStream();
    const local = this.localStream;
    for (const kind of ['audio', 'video'] as const) {
      const track = local?.getTracks().find((t) => t.kind === kind);
      if (track && local) {
        const sender = pc.addTrack(track, local);
        if (kind === 'video') void this.tuneVideoSender(sender);
      } else {
        pc.addTransceiver(kind, { direction: 'recvonly' });
      }
    }
    pc.ontrack = (ev) => {
      this.remoteStream?.addTrack(ev.track);
      this.set({ remoteStream: this.remoteStream });
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.remoteId) this.send({ type: 'ice', from: this.peerId, to: this.remoteId, candidate: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => this.onConnectionState(pc);
    return pc;
  }

  private async tuneVideoSender(sender: RTCRtpSender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 1_500_000;
      (params as { degradationPreference?: string }).degradationPreference = 'maintain-resolution';
      await sender.setParameters(params);
    } catch {
      /* optional optimisation */
    }
  }

  private closePc() {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.lastStats = null;
    this.pendingIce = [];
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.close();
      this.pc = null;
    }
  }

  private async makeOffer(restart: boolean) {
    if (!this.remoteId || this.makingOffer || this.destroyed) return;
    const pc = this.ensurePc();
    this.makingOffer = true;
    try {
      const offer = await pc.createOffer({ iceRestart: restart });
      await pc.setLocalDescription(offer);
      if (pc.localDescription && this.remoteId) {
        this.send({ type: 'offer', from: this.peerId, to: this.remoteId, sdp: pc.localDescription.sdp, restart });
      }
    } finally {
      this.makingOffer = false;
    }
  }

  private async onSignal(msg: SignalMessage) {
    if (this.destroyed) return;
    if ('to' in msg && msg.to !== this.peerId) return;
    if (this.remoteId && msg.from !== this.remoteId) return;

    switch (msg.type) {
      case 'offer': {
        if (this.opts.role !== 'expert') return;
        this.remoteId = msg.from;
        const pc = this.ensurePc();
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        await this.flushIce(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (pc.localDescription) this.send({ type: 'answer', from: this.peerId, to: msg.from, sdp: pc.localDescription.sdp });
        break;
      }
      case 'answer': {
        const pc = this.pc;
        if (!pc || pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        await this.flushIce(pc);
        break;
      }
      case 'ice': {
        const pc = this.pc;
        if (!pc || !pc.remoteDescription) this.pendingIce.push(msg.candidate);
        else await pc.addIceCandidate(msg.candidate).catch(() => undefined);
        break;
      }
      case 'restart':
        if (this.opts.role === 'technician') void this.makeOffer(true);
        break;
      case 'recording':
        if (this.opts.role === 'expert') this.set({ remoteRecording: msg.on });
        break;
      case 'bye':
        if (this.opts.role === 'expert') this.finish();
        else this.dropRemote();
        break;
    }
  }

  private async flushIce(pc: RTCPeerConnection) {
    const queued = this.pendingIce.splice(0);
    for (const c of queued) await pc.addIceCandidate(c).catch(() => undefined);
  }

  private onConnectionState(pc: RTCPeerConnection) {
    if (pc !== this.pc || this.destroyed) return;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;

    switch (pc.connectionState) {
      case 'connected':
        this.restartAttempts = 0;
        this.set({ phase: 'connected' });
        this.startStats(pc);
        break;
      case 'disconnected':
        this.set({ phase: 'reconnecting' });
        this.disconnectTimer = setTimeout(() => this.recover(), 3_000);
        break;
      case 'failed':
        this.set({ phase: 'reconnecting' });
        this.recover();
        break;
      default:
        break;
    }
  }

  private recover() {
    if (this.destroyed || !this.remoteId) return;
    if (this.restartAttempts >= 4) {
      this.set({ phase: 'failed' });
      return;
    }
    const delay = reconnectDelay(this.restartAttempts++);
    this.disconnectTimer = setTimeout(() => {
      if (this.opts.role === 'technician') void this.makeOffer(true).catch(() => undefined);
      else this.send({ type: 'restart', from: this.peerId, to: this.remoteId as string });
    }, delay);
  }

  private startStats(pc: RTCPeerConnection) {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = setInterval(async () => {
      if (pc !== this.pc) return;
      try {
        const report = await pc.getStats();
        let rtt: number | null = null;
        let relayed = false;
        let bytes = 0;
        let lost = 0;
        let received = 0;
        let hasVideo = false;
        report.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) {
            if (typeof r.currentRoundTripTime === 'number') rtt = r.currentRoundTripTime * 1000;
            const local = report.get(r.localCandidateId);
            relayed = local?.candidateType === 'relay';
          }
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            hasVideo = true;
            bytes += r.bytesReceived ?? 0;
            lost += r.packetsLost ?? 0;
            received += r.packetsReceived ?? 0;
          }
        });
        const now = Date.now();
        let kbps: number | null = null;
        let lossPct: number | null = null;
        if (this.lastStats) {
          const dt = (now - this.lastStats.at) / 1000;
          if (dt > 0 && hasVideo) kbps = ((bytes - this.lastStats.bytes) * 8) / 1000 / dt;
          const total = received - this.lastStats.received + (lost - this.lastStats.lost);
          if (total > 0) lossPct = (Math.max(0, lost - this.lastStats.lost) / total) * 100;
        }
        this.lastStats = { at: now, bytes, lost, received };
        this.set({ quality: assessQuality({ rttMs: rtt, lossPct, bitrateKbps: kbps, expectVideo: hasVideo }), relayed });
      } catch {
        /* stats are best effort */
      }
    }, LIMITS.STATS_MS);
  }

  private send(msg: SignalMessage) {
    void this.channel?.send({ type: 'broadcast', event: 'sig', payload: msg });
  }

  // ---------------------------------------------------------- recording (technician)

  async startRecording(): Promise<boolean> {
    if (this.opts.role !== 'technician' || this.s.recording === 'recording') return false;
    const video = this.localStream?.getVideoTracks()[0];
    const picked = pickRecorderMime((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
    if (!video || !picked) {
      this.set({ recordError: 'Recording is not available on this device.' });
      return false;
    }
    try {
      const tracks: MediaStreamTrack[] = [video];
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        await ctx.resume();
        const dest = ctx.createMediaStreamDestination();
        const mic = this.localStream?.getAudioTracks()[0];
        const far = this.remoteStream?.getAudioTracks()[0];
        if (mic) ctx.createMediaStreamSource(new MediaStream([mic])).connect(dest);
        if (far) ctx.createMediaStreamSource(new MediaStream([far])).connect(dest);
        tracks.push(...dest.stream.getAudioTracks());
        this.audioCtx = ctx;
      }
      const rec = new MediaRecorder(new MediaStream(tracks), {
        mimeType: picked.mime,
        videoBitsPerSecond: LIMITS.VIDEO_BITRATE,
        audioBitsPerSecond: LIMITS.AUDIO_BITRATE,
      });
      this.recChunks = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) this.recChunks.push(e.data);
      };
      rec.onerror = () => {
        this.cleanupRecorder();
        this.set({ recording: 'idle', recordError: 'Recording stopped unexpectedly.' });
      };
      rec.onstop = () => {
        const seconds = Math.max(1, Math.round((Date.now() - this.recStartedAt) / 1000));
        const blob = new Blob(this.recChunks, { type: picked.base });
        this.cleanupRecorder();
        this.set({ recording: 'idle', recordingSeconds: 0 });
        this.send({ type: 'recording', from: this.peerId, on: false });
        if (blob.size > 0 && !this.destroyed) this.opts.onClip({ blob, mime: picked.base, ext: picked.ext, durationSeconds: seconds });
      };
      this.recorder = rec;
      this.recStartedAt = Date.now();
      rec.start(1_000);
      this.recTimer = setInterval(() => {
        const secs = Math.round((Date.now() - this.recStartedAt) / 1000);
        this.set({ recordingSeconds: secs });
        if (secs >= LIMITS.MAX_CLIP_SECONDS) this.stopRecording();
      }, 500);
      this.set({ recording: 'recording', recordingSeconds: 0, recordError: null });
      this.send({ type: 'recording', from: this.peerId, on: true });
      return true;
    } catch {
      this.cleanupRecorder();
      this.set({ recording: 'idle', recordError: 'Could not start recording on this device.' });
      return false;
    }
  }

  stopRecording() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
  }

  private cleanupRecorder() {
    if (this.recTimer) clearInterval(this.recTimer);
    this.recTimer = null;
    this.recorder = null;
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
  }

  // ---------------------------------------------------------- lifecycle

  private finish() {
    this.closePc();
    this.set({ phase: 'ended', remoteStream: null, quality: 'unknown' });
  }

  /** Technician ended the session for everyone. */
  endForAll() {
    this.send({ type: 'bye', from: this.peerId });
    this.stopRecording();
    this.finish();
  }

  private async acquireWakeLock() {
    try {
      const nav = navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
      this.wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      /* not supported or denied */
    }
  }

  destroy() {
    if (this.destroyed) return;
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.cleanupRecorder();
    this.closePc();
    if (this.channel) {
      void this.channel.untrack().catch(() => undefined);
      void supabase.removeChannel(this.channel);
      this.channel = null;
    }
    this.localStream?.getTracks().forEach((t) => t.stop());
    void this.wakeLock?.release().catch(() => undefined);
    this.destroyed = true;
  }
}
