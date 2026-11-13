// Recreated: verify against original intent
import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { Panel } from '@/components/ui/Panel';
import { OperatorPanel } from '@/components/operator/OperatorPanel';
import { useChiefT } from '@/i18n/chiefOfStaffNamespace';
import { speechLang } from '@/lib/chiefOfStaff';

const MAX_COMMAND = 500;

// The Web Speech API is not in lib.dom for every TS version; type just what is used.
interface SpeechRecognitionResultLike {
  readonly 0: { readonly transcript: string };
  readonly isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognition(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Free-text command for the Operator. Typing or speaking only fills the box; nothing runs until the person
 * presses "Review plan", and the Operator always shows a preview before any change (see OperatorPanel).
 */
export function CommandBox() {
  const { t, language } = useChiefT();
  const [text, setText] = useState('');
  const [instruction, setInstruction] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const supported = typeof window !== 'undefined' && getRecognition() !== null;

  useEffect(() => () => recRef.current?.abort(), []);

  const stopVoice = () => recRef.current?.stop();

  const startVoice = () => {
    const Ctor = getRecognition();
    if (!Ctor) {
      setVoiceMsg(t('command.voice.unsupported'));
      return;
    }
    setVoiceMsg(null);
    const rec = new Ctor();
    rec.lang = speechLang(language);
    rec.continuous = false;
    rec.interimResults = false;
    let heard = false;
    rec.onresult = (e) => {
      let chunk = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) chunk += e.results[i][0].transcript;
      }
      if (chunk.trim()) {
        heard = true;
        setText((prev) => `${prev ? `${prev} ` : ''}${chunk.trim()}`.slice(0, MAX_COMMAND));
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setVoiceMsg(t('command.voice.notAllowed'));
      else if (e.error === 'no-speech') setVoiceMsg(t('command.voice.noSpeech'));
      else if (e.error !== 'aborted') setVoiceMsg(t('command.voice.failed'));
      heard = true; // an error message is already shown; do not add the "heard nothing" one
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
      if (!heard) setVoiceMsg((m) => m ?? t('command.voice.noSpeech'));
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      recRef.current = null;
      setVoiceMsg(t('command.voice.failed'));
    }
  };

  if (instruction !== null) {
    return (
      <Panel title={t('command.title')} flush aria-label={t('command.title')}>
        <OperatorPanel instruction={instruction} onBack={() => setInstruction(null)} onClose={() => { setInstruction(null); setText(''); }} />
      </Panel>
    );
  }

  const trimmed = text.trim();

  return (
    <Panel title={t('command.title')} aria-label={t('command.title')}>
      <Textarea
        label={t('command.label')}
        placeholder={t('command.placeholder')}
        value={text}
        rows={2}
        maxLength={MAX_COMMAND}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && trimmed) setInstruction(trimmed);
        }}
      />
      <p className="mt-2 text-xs text-text-secondary">{t('command.hint')}</p>
      {voiceMsg && <p role="status" className="mt-2 text-xs text-text-secondary">{voiceMsg}</p>}
      {listening && <p role="status" className="mt-2 text-xs text-text-primary">{t('command.voice.listening')}</p>}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {supported && (
          <Button size="sm" variant="secondary" onClick={listening ? stopVoice : startVoice} selected={listening}>
            {listening ? <MicOff size={14} aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />}
            {listening ? t('command.voice.stop') : t('command.voice.start')}
          </Button>
        )}
        <Button size="sm" onClick={() => setInstruction(trimmed)} disabled={!trimmed}>
          <Sparkles size={14} aria-hidden="true" />
          {t('command.run')}
        </Button>
      </div>
    </Panel>
  );
}
