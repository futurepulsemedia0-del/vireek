import { Fragment } from 'react';
import { parseBody } from '@/lib/comments';

interface Props {
  body: string;
  /** Ids the SERVER accepted as mentions; anything else renders as plain "@Name". */
  mentions: string[];
  currentUserId?: string | null;
}

/** Renders a stored comment body. Plain React nodes only — never injects HTML. */
export function CommentBody({ body, mentions, currentUserId }: Props) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text-primary">
      {parseBody(body).map((seg, i) => {
        if (seg.type === 'text') return <Fragment key={i}>{seg.text}</Fragment>;
        const real = mentions.includes(seg.userId);
        if (!real) return <Fragment key={i}>@{seg.name}</Fragment>;
        const me = !!currentUserId && seg.userId === currentUserId;
        return (
          <span
            key={i}
            data-mention={seg.userId}
            className={`rounded-md px-1 py-0.5 font-medium ${me ? 'bg-warning-500/15 text-warning-500' : 'bg-accent/10 text-accent'}`}
          >
            @{seg.name}
            {me && <span className="sr-only"> (you)</span>}
          </span>
        );
      })}
    </p>
  );
}
