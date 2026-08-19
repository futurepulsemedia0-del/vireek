import { HTMLAttributes, forwardRef } from 'react';

type CardProps = HTMLAttributes<HTMLDivElement>;

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className = '', children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`rounded-2xl border border-border bg-bg-secondary p-8 shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = 'Card';
