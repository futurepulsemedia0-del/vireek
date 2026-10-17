import { memo, useState } from 'react';
import { AlertCircle, Check, CheckCheck, Clock, ImageOff, MoreHorizontal, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import { ChatVoicePlayer } from '@/components/teamchat/ChatVoicePlayer';
import { canDelete, canEdit, receiptLabel, type ChatMessage, type Receipt } from '@/lib/teamChat';
import { Button } from '@/components/ui/Button';

interface Props {
  message: ChatMessage;
  own: boolean;
  senderName: string;
  showSender: boolean;
  endsGroup: boolean;
  mediaUrl: string | null;
  receipt: Receipt | null;
  isDirect: boolean;
  names: Map<string, string>;
  onOpenImage: (url: string) => void;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
  onEdit: (id: string, text: string) => Promise<string | null>;
  onDelete: (m: ChatMessage) => void;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function Ticks({ receipt, label }: { receipt: Receipt; label: string }) {
  const icon =
    receipt.state === 'read' ? (
      <CheckCheck size={14} className="text-sky-200" aria-hidden="true" />
    ) : receipt.state === 'sent' ? (
      <Check size={14} aria-hidden="true" />
    ) : receipt.state === 'failed' ? (
      <AlertCircle size={14} aria-hidden="true" />
    ) : (
      <Clock size={13} aria-hidden="true" />
    );
  return (
    <span className="inline-flex items-center gap-1" title={label}>
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function BubbleImpl(props: Props) {
  const { message: m, own, senderName, showSender, endsGroup, mediaUrl, receipt, isDirect, names } = props;
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  if (m.kind === 'system') {
    return <p className="my-2 text-center text-xs text-text-secondary">{m.body}</p>;
  }

  const bubbleTone = own ? 'bg-accent text-white' : 'border border-border bg-bg-secondary text-text-primary';
  const radius = own
    ? `rounded-2xl ${endsGroup ? 'rounded-br-md' : ''}`
    : `rounded-2xl ${endsGroup ? 'rounded-bl-md' : ''}`;

  const url = m.localUrl ?? mediaUrl;
  const deleted = Boolean(m.deleted_at);
  const label = receipt ? receiptLabel(receipt, names, isDirect) : '';

  const saveEdit = async () => {
    const err = await props.onEdit(m.id, draft);
    if (err) setEditError(err);
    else setEditing(false);
  };

  return (
    <div className={`group flex flex-col ${own ? 'items-end' : 'items-start'} ${showSender ? 'mt-3' : 'mt-0.5'}`}>
      {showSender && !own && <span className="mb-1 px-1 text-xs font-medium text-text-secondary">{senderName}</span>}

      <div className={`relative flex max-w-[85%] items-end gap-1 sm:max-w-[70%] ${own ? 'flex-row-reverse' : ''}`}>
        <div className={`${bubbleTone} ${radius} px-3.5 py-2 shadow-sm ${m.status === 'failed' ? 'ring-2 ring-danger/60' : ''}`}>
          {deleted ? (
            <p className={`text-sm italic ${own ? 'text-white/80' : 'text-text-secondary'}`}>This message was deleted</p>
          ) : editing ? (
            <div className="w-64 max-w-full space-y-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                maxLength={4000}
                aria-label="Edit message"
                className="focus-ring w-full resize-none rounded-lg border border-border bg-bg-primary p-2 text-sm text-text-primary"
              />
              {editError && <p role="alert" className="text-xs text-white">{editError}</p>}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="secondary" onClick={saveEdit}>
                  Save
                </Button>
              </div>
            </div>
          ) : m.kind === 'image' ? (
            url && !imgFailed ? (
              <button type="button" onClick={() => props.onOpenImage(url)} className="focus-ring block overflow-hidden rounded-xl" aria-label="Open photo">
                <img
                  src={url}
                  alt="Shared photo"
                  loading="lazy"
                  onError={() => setImgFailed(true)}
                  className={`max-h-72 w-auto max-w-full object-cover ${m.status === 'sending' ? 'opacity-60' : ''}`}
                />
              </button>
            ) : (
              <div className="flex h-24 w-40 items-center justify-center gap-2 text-sm opacity-80">
                <ImageOff size={18} aria-hidden="true" /> {imgFailed ? 'Photo unavailable' : 'Loading…'}
              </div>
            )
          ) : m.kind === 'voice' ? (
            <ChatVoicePlayer url={url} durationMs={m.voice_duration_ms ?? 0} own={own} />
          ) : (
            <p className="whitespace-pre-wrap break-words text-[15px] leading-snug [overflow-wrap:anywhere]">{m.body}</p>
          )}

          <div className={`mt-1 flex items-center justify-end gap-1.5 text-[11px] ${own ? 'text-white/80' : 'text-text-secondary'}`}>
            {m.edited_at && !deleted && <span>edited</span>}
            <time dateTime={m.created_at}>{time(m.created_at)}</time>
            {own && receipt && !deleted && <Ticks receipt={receipt} label={label} />}
          </div>
        </div>

        {own && !deleted && !editing && !m.status && (canEdit(m, m.sender_id) || canDelete(m, m.sender_id)) && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenu((v) => !v)}
              aria-label="Message actions"
              aria-expanded={menu}
              className="focus-ring flex h-8 w-8 items-center justify-center rounded-full text-text-secondary opacity-0 transition-opacity hover:bg-bg-tertiary focus:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <MoreHorizontal size={16} />
            </button>
            {menu && (
              <div role="menu" className="absolute bottom-9 right-0 z-10 w-36 rounded-xl border border-border bg-bg-secondary p-1 shadow-card">
                {canEdit(m, m.sender_id) && (
                  <button
                    role="menuitem"
                    type="button"
                    className="focus-ring flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-primary hover:bg-bg-tertiary"
                    onClick={() => {
                      setMenu(false);
                      setDraft(m.body ?? '');
                      setEditError(null);
                      setEditing(true);
                    }}
                  >
                    <Pencil size={14} /> Edit
                  </button>
                )}
                <button
                  role="menuitem"
                  type="button"
                  className="focus-ring flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-danger hover:bg-danger/10"
                  onClick={() => {
                    setMenu(false);
                    props.onDelete(m);
                  }}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {m.status === 'failed' && m.client_id && (
        <div className="mt-1 flex items-center gap-3 px-1 text-xs text-danger" role="alert">
          <span>Not sent.</span>
          <button type="button" onClick={() => props.onRetry(m.client_id as string)} className="focus-ring inline-flex items-center gap-1 font-semibold underline">
            <RotateCcw size={12} /> Retry
          </button>
          <button type="button" onClick={() => props.onDiscard(m.client_id as string)} className="focus-ring inline-flex items-center gap-1 font-semibold underline">
            <X size={12} /> Discard
          </button>
        </div>
      )}
    </div>
  );
}

export const ChatMessageBubble = memo(BubbleImpl);
