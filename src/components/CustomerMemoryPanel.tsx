import { useEffect, useState } from 'react';
import { Brain, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface MemoryItem {
  id: string;
  fact: string;
  category: string;
  source: string;
  created_at: string;
}

export function CustomerMemoryPanel({ phone }: { phone: string | null }) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!phone) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    supabase
      .from('customer_memory')
      .select('id, fact, category, source, created_at')
      .eq('customer_phone', phone)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (!cancelled) {
          setItems(data ?? []);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [phone]);

  const handleDelete = async (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    await supabase.from('customer_memory').delete().eq('id', id);
  };

  if (loading || items.length === 0) return null;

  return (
    <div className="space-y-2 rounded-xl border border-border bg-bg-primary p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        <Brain size={14} /> What Sarah remembers about this customer
      </p>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-2 rounded-lg bg-bg-secondary px-3 py-2 text-sm text-text-primary">
            <span>{item.fact}</span>
            <button
              type="button"
              onClick={() => handleDelete(item.id)}
              className="focus-ring shrink-0 rounded p-0.5 text-text-secondary hover:text-danger"
              aria-label="Forget this"
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
