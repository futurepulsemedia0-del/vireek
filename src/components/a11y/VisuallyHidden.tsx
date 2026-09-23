// src/components/a11y/VisuallyHidden.tsx
//
// محتوایی فقط برای screen reader — بصری مخفیه ولی توی accessibility
// tree می‌مونه. برای دکمه‌های فقط-آیکون بدون متن قابل‌مشاهده استفاده کن.
import type { ReactNode, ElementType } from 'react';

interface VisuallyHiddenProps {
  as?: ElementType;
  children: ReactNode;
  className?: string;
}

export function VisuallyHidden({ as: Tag = 'span', children, className = '' }: VisuallyHiddenProps) {
  return <Tag className={`sr-only ${className}`.trim()}>{children}</Tag>;
}
