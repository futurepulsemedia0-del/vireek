import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

interface BackButtonProps {
  fallback: string;
  to?: string;
  className?: string;
}

export function BackButton({ fallback, to, className = '' }: BackButtonProps) {
  const navigate = useNavigate();

  const handleClick = () => {
    if (to) {
      navigate(to);
      return;
    }
    if (window.history.state && window.history.state.idx > 0) {
      navigate(-1);
    } else {
      navigate(fallback, { replace: true });
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary ${className}`}
    >
      <ArrowLeft size={16} />
      Back
    </button>
  );
}
