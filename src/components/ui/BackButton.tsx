import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { motion } from 'framer-motion';

export interface BackButtonProps {
  label?: string;
  fallback?: string;
  className?: string;
}

export function BackButton({
  label = 'Back',
  fallback = '/',
  className = '',
}: BackButtonProps) {
  const navigate = useNavigate();

  const handleClick = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(fallback);
    }
  };

  return (
    <motion.button
      type="button"
      onClick={handleClick}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      whileTap={{ scale: 0.97, transition: { duration: 0.1 } }}
      className={`group inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-medium text-text-secondary shadow-sm backdrop-blur transition-all duration-200 ease-out hover:border-accent/30 hover:bg-bg-secondary hover:text-accent focus-ring ${className}`}
    >
      <ArrowLeft
        aria-hidden="true"
        size={16}
        strokeWidth={2}
        className="transition-transform duration-200 ease-out group-hover:-translate-x-[3px]"
      />
      <span>{label}</span>
    </motion.button>
  );
}
