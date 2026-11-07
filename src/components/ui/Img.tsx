import { useState, type ImgHTMLAttributes, type ReactElement } from 'react';
import { IMAGES } from '@/lib/images.generated';
import { IMAGE_SIZES, imageSrcSet } from '@/lib/responsiveImage';

/**
 * Accessibility contract (compile-time):
 *  - Informative image  -> `alt="…"` (concise, localized with t(); never "image of …").
 *  - Decorative image   -> `decorative` (renders alt="" + aria-hidden). There is no way to omit both.
 */
type AltProps =
  | { alt: string; decorative?: never }
  | { alt?: never; decorative: true };

/**
 * Layout-stability contract (compile-time):
 *  - Intrinsic size (`width` + `height`, px) — the browser derives the aspect ratio before the file loads; or
 *  - `aspectRatio` (e.g. `"4 / 3"` or `1.5`) when the rendered box is fluid and the intrinsic size is unknown
 *    (user uploads, signed URLs).
 */
type SizeProps =
  | { width: number; height: number; aspectRatio?: never }
  | { width?: never; height?: never; aspectRatio: number | `${number} / ${number}` | `auto ${number} / ${number}` };

type NativeProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  'alt' | 'width' | 'height' | 'loading' | 'decoding' | 'fetchPriority' | 'src' | 'srcSet' | 'sizes'
>;

type ImgBaseProps = NativeProps & {
  src: string;
  /**
   * The single LCP image of a route. Switches to loading="eager" + fetchPriority="high".
   * Use on at most ONE image per page (enforced by a dev-time warning).
   */
  priority?: boolean;
  /**
   * Name of an asset processed by `scripts/optimize-images.mjs` (key in images.generated.ts).
   * When present the image is rendered as <picture> with AVIF → WebP → original `src` fallback.
   */
  asset?: string;
  sizes?: string;
  /** Low-cost placeholder: a design-token background shown until the image decodes. No blur data-URIs, no JS. */
  placeholder?: boolean;
  /** Called after the image failed to load; the component then renders a neutral token-coloured box with the same size. */
  onLoadError?: () => void;
};

export type ImgProps = ImgBaseProps & AltProps & SizeProps;

let priorityCount = 0;

export function Img(props: ImgProps): ReactElement {
  const {
    src,
    priority = false,
    asset,
    sizes = IMAGE_SIZES,
    placeholder = true,
    onLoadError,
    className = '',
    style,
    onError,
    onLoad,
    ...rest
  } = props;
  const { alt, decorative, width, height, aspectRatio, ...native } = rest as typeof rest & {
    alt?: string;
    decorative?: true;
    width?: number;
    height?: number;
    aspectRatio?: number | string;
  };

  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (import.meta.env.DEV) {
    if (!decorative && (alt === undefined || alt.trim() === '')) {
      console.warn(`<Img src="${src}">: informative images need a non-empty alt. Use \`decorative\` for decorative ones.`);
    }
    if (decorative && alt) console.warn(`<Img src="${src}">: \`decorative\` ignores alt.`);
    if (priority && ++priorityCount > 1) {
      console.warn('<Img priority>: more than one LCP-priority image mounted; only the real LCP element should set it.');
    }
  }

  const meta = asset ? IMAGES[asset] : undefined;
  const boxStyle = {
    ...(aspectRatio !== undefined ? { aspectRatio: String(aspectRatio) } : null),
    ...style,
  };
  const placeholderClass = placeholder && !loaded ? 'bg-bg-secondary' : '';

  if (failed) {
    return (
      <span
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : alt}
        aria-hidden={decorative ? true : undefined}
        className={`inline-block bg-bg-secondary ${className}`}
        style={{ ...boxStyle, width, height }}
      />
    );
  }

  const img = (
    <img
      {...native}
      src={src}
      alt={decorative ? '' : alt}
      aria-hidden={decorative ? true : undefined}
      width={width}
      height={height}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      fetchPriority={priority ? 'high' : 'auto'}
      style={boxStyle}
      className={`${placeholderClass} ${className}`.trim()}
      onLoad={(e) => {
        setLoaded(true);
        onLoad?.(e);
      }}
      onError={(e) => {
        setFailed(true);
        onLoadError?.();
        onError?.(e);
      }}
    />
  );

  if (!meta) return img;
  return (
    <picture className="contents">
      <source type="image/avif" srcSet={imageSrcSet(asset as string, meta.widths, 'avif')} sizes={sizes} />
      <source type="image/webp" srcSet={imageSrcSet(asset as string, meta.widths, 'webp')} sizes={sizes} />
      {img}
    </picture>
  );
}
