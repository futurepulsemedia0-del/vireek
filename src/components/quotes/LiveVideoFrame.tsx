/**
 * Daily.co Prebuilt call inside an iframe. No npm dependency: the CSP already
 * allows https://*.daily.co in frame-src / connect-src, and vercel.json's
 * Permissions-Policy must delegate camera + microphone to daily.co (see notes).
 * Used by both the technician panel and the customer quote page.
 */

interface LiveVideoFrameProps {
  url: string;
  title: string;
}

export function LiveVideoFrame({ url, title }: LiveVideoFrameProps) {
  return (
    <iframe
      src={url}
      title={title}
      allow="camera; microphone; fullscreen; display-capture; autoplay; speaker-selection"
      referrerPolicy="no-referrer"
      className="h-[70vh] min-h-[360px] w-full rounded-xl border border-border bg-black"
    />
  );
}
