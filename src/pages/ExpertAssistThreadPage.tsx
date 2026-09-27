import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { AnnotatableImage } from '@/components/AnnotatableImage';
import {
  fetchRequest, fetchMessages, subscribeToThread, claimRequest, resolveRequest,
  sendPhotoMessage, sendAudioMessage, sendTextMessage, sendAnnotation, getSignedMediaUrl,
  ExpertAssistRequest, ExpertAssistMessage,
} from '@/lib/expertAssist';

export function ExpertAssistThreadPage() {
  const { requestId } = useParams<{ requestId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [request, setRequest] = useState<ExpertAssistRequest | null>(null);
  const [messages, setMessages] = useState<ExpertAssistMessage[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [myTeamMemberId, setMyTeamMemberId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [resolveSummary, setResolveSummary] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const load = useCallback(async () => {
    if (!requestId) return;
    const [req, msgs] = await Promise.all([fetchRequest(requestId), fetchMessages(requestId)]);
    setRequest(req);
    setMessages(msgs);
    const photoPaths = msgs.filter((m) => m.media_path).map((m) => m.media_path as string);
    const entries = await Promise.all(photoPaths.map(async (p) => [p, await getSignedMediaUrl(p)] as const));
    setSignedUrls(Object.fromEntries(entries));
  }, [requestId]);

  useEffect(() => {
    supabase.rpc('get_my_team_member_id').then(({ data }) => setMyTeamMemberId(data ?? null));
  }, []);

  useEffect(() => {
    load();
    if (!requestId) return;
    return subscribeToThread(requestId, load);
  }, [requestId, load]);

  if (!request) return <div className="p-6 text-center text-text-secondary">Loading…</div>;

  const isExpert = request.assigned_expert_id === myTeamMemberId;
  const isRequester = request.requested_by === myTeamMemberId;
  const canClaim = request.status === 'open' && !isRequester;

  async function handlePhotoPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user || !requestId) return;
    await sendPhotoMessage(user.id, requestId, file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleSendText() {
    if (!text.trim() || !requestId) return;
    await sendTextMessage(requestId, text.trim());
    setText('');
  }

  async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      if (user && requestId) await sendAudioMessage(user.id, requestId, blob);
      stream.getTracks().forEach((t) => t.stop());
    };
    recorder.start();
    mediaRecorderRef.current = recorder;
    setRecording(true);
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  async function handleClaim() {
    if (!requestId) return;
    await claimRequest(requestId);
    load();
  }

  async function handleResolve() {
    if (!requestId || !resolveSummary.trim()) return;
    await resolveRequest(requestId, resolveSummary.trim(), true);
    load();
  }

  return (
    <div className="min-h-screen bg-bg-primary pb-28">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg-primary/95 px-4 py-4 backdrop-blur">
        <div>
          <h1 className="font-semibold text-text-primary">Expert Assist</h1>
          <p className="text-xs text-text-secondary">Status: {request.status}{request.error_code ? ` · ${request.error_code}` : ''}</p>
        </div>
        <button onClick={() => navigate(-1)} className="text-sm text-accent">Close</button>
      </header>

      <main className="mx-auto max-w-lg space-y-3 px-4 py-4">
        {canClaim && (
          <button onClick={handleClaim} className="w-full rounded-lg bg-accent py-3 font-semibold text-white">
            Claim this request
          </button>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`rounded-lg p-3 ${m.sender_team_member_id === myTeamMemberId ? 'bg-accent/10' : 'bg-bg-secondary'}`}>
            {m.kind === 'text' && <p className="text-sm text-text-primary">{m.body}</p>}
            {m.kind === 'audio' && m.media_path && signedUrls[m.media_path] && (
              <audio controls src={signedUrls[m.media_path]} className="w-full" />
            )}
            {m.kind === 'photo' && m.media_path && signedUrls[m.media_path] && (
              <AnnotatableImage
                imageUrl={signedUrls[m.media_path]}
                existingAnnotations={messages
                  .filter((a) => a.kind === 'annotation' && a.annotation_data?.target_message_id === m.id)
                  .flatMap((a) => a.annotation_data?.points || [])}
                editable={isExpert && requestId !== undefined}
                onAddPoint={(point) => requestId && sendAnnotation(requestId, m.id, [point])}
              />
            )}
          </div>
        ))}
      </main>

      {request.status !== 'resolved' && (
        <div className="fixed inset-x-0 bottom-0 space-y-2 border-t border-border bg-bg-primary p-3">
          {isExpert && (
            <div className="flex gap-2">
              <input
                value={resolveSummary}
                onChange={(e) => setResolveSummary(e.target.value)}
                placeholder="Resolution summary (saved to knowledge base)"
                className="flex-1 rounded-md border border-border bg-bg-secondary px-2 py-2 text-sm"
              />
              <button onClick={handleResolve} className="rounded-md bg-success-500 px-3 py-2 text-sm font-medium text-white">Resolve</button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendText()}
              placeholder="Type a message…"
              className="flex-1 rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm"
            />
            <button onClick={handleSendText} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">Send</button>
            <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={handlePhotoPick} className="hidden" id="expert-photo-input" />
            <button onClick={() => fileInputRef.current?.click()} className="rounded-md border border-border px-3 py-2 text-sm">📷</button>
            <button onClick={recording ? stopRecording : startRecording} className={`rounded-md px-3 py-2 text-sm ${recording ? 'bg-danger text-white' : 'border border-border'}`}>
              {recording ? '⏹' : '🎙'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
