import { HTMLAttributes, forwardRef } from 'react';

type CardProps = HTMLAttributes<HTMLDivElement>;

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className = '', children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`rounded-2xl border border-border/80 bg-bg-secondary p-8 shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover dark:bg-bg-secondary/95 dark:shadow-card-dark dark:hover:shadow-card-hover-dark ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = 'Card';
