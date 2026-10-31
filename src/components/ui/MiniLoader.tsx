// src/components/ui/MiniLoader.tsx
//
// Compact version of the brand comet-ring used by RouteLoader. Uses
// currentColor, so it always matches the text color of the control it sits in.
// Purely decorative: loading is announced through the global live region
// (see Button), never through this element.
export function MiniLoader({ size = 16, className = '' }: { size?: number; className?: string }) {
  return <span aria-hidden="true" className={`vrk-mini ${className}`} style={{ width: size, height: size }} />;
}
