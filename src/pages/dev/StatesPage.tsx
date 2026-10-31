// src/pages/dev/StatesPage.tsx
//
// Dev-only catalog of every interaction state for every shared component.
// Internal tool (not shipped to customers; route is gated in App.tsx), so its
// labels are intentionally plain English rather than i18n keys.
import { useState } from 'react';
import { Copy, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Switch } from '@/components/ui/Switch';
import { Card } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/contexts/ToastContext';
import { useAction } from '@/hooks/useAction';
import { surfaceClass } from '@/lib/ui/interaction';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`s-${title}`} className="space-y-4 border-t border-border pt-8">
      <h2 id={`s-${title}`} className="text-lg font-semibold text-text-primary">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Cell({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div data-state-cell={name} className="flex flex-col items-start gap-2">
      <span className="text-xs text-text-secondary">{name}</span>
      {children}
    </div>
  );
}

const grid = 'grid grid-cols-2 gap-6 md:grid-cols-4';

export default function StatesPage() {
  const { toast } = useToast();
  const [on, setOn] = useState(true);
  const [tab, setTab] = useState('a');
  const [picked, setPicked] = useState<string | null>('r2');
  const [pressed, setPressed] = useState(false);
  const action = useAction(async (_ctx, ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
    toast('Saved', 'success');
  });

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-4 py-10">
      <h1 className="text-2xl font-semibold text-text-primary">Interaction states</h1>
      <p className="text-sm text-text-secondary">
        Hover, focus-visible and pressed are real states: interact with a control to see them (hover only on hover-capable devices).
      </p>

      <Section title="Button">
        <div className={grid}>
          {(['primary', 'secondary', 'ghost', 'danger'] as const).map((v) => (
            <Cell key={v} name={`${v} / default`}>
              <Button variant={v}>Action</Button>
            </Cell>
          ))}
          <Cell name="selected (toggle)">
            <Button variant="secondary" selected={pressed} onClick={() => setPressed((p) => !p)}>
              Toggle
            </Button>
          </Cell>
          <Cell name="disabled">
            <Button disabled>Action</Button>
          </Cell>
          <Cell name="disabled + reason">
            <Button disabled disabledReason="Upgrade to Professional to use this">
              Export
            </Button>
          </Cell>
          <Cell name="loading">
            <Button loading>Pay now</Button>
          </Cell>
          <Cell name="live: useAction (click fast)">
            <Button loading={action.pending} onClick={() => void action.run(1500)}>
              Save
            </Button>
          </Cell>
        </div>
      </Section>

      <Section title="IconButton">
        <div className={grid}>
          <Cell name="default">
            <IconButton label="Edit" icon={Pencil} />
          </Cell>
          <Cell name="disabled + reason">
            <IconButton label="Delete" icon={Trash2} disabled disabledReason="Only owners can delete" />
          </Cell>
          <Cell name="loading">
            <IconButton label="Delete" icon={Trash2} loading variant="secondary" />
          </Cell>
          <Cell name="tooltip">
            <Tooltip content="Appears on hover and keyboard focus; Escape dismisses">
              <Button variant="secondary" size="sm">
                Hover or focus me
              </Button>
            </Tooltip>
          </Cell>
        </div>
      </Section>

      <Section title="Link">
        <div className={grid}>
          <Cell name="default / hover">
            <a href="#states" className={`focus-ring rounded font-medium ${surfaceClass('link')}`}>
              Link
            </a>
          </Cell>
          <Cell name="selected (current)">
            <a href="#states" data-selected="true" aria-current="page" className={`focus-ring rounded font-medium ${surfaceClass('link')}`}>
              Current
            </a>
          </Cell>
        </div>
      </Section>

      <Section title="Form controls">
        <div className="grid gap-6 md:grid-cols-2">
          <Input label="Default" placeholder="Type here" />
          <Input label="Error" defaultValue="bad" error="This value is not valid" />
          <Input label="Disabled" disabled defaultValue="Locked" />
          <Input label="Read only" readOnly defaultValue="Read only" />
          <Select label="Select" defaultValue="b">
            <option value="a">Option A</option>
            <option value="b">Option B</option>
          </Select>
          <Select label="Select (error)" error="Pick a valid option">
            <option value="">Choose…</option>
          </Select>
          <Checkbox label="Checkbox" defaultChecked />
          <Checkbox label="Checkbox (disabled)" disabled disabledReason="Requires the Professional plan" />
          <Checkbox label="Checkbox (error)" error="You must accept" />
          <Switch label="Switch" checked={on} onChange={setOn} hint="Applies immediately" />
          <Switch label="Switch (disabled)" checked={false} onChange={() => undefined} disabled disabledReason="Managed by your admin" />
          <Switch label="Switch (saving)" checked onChange={() => undefined} loading />
        </div>
      </Section>

      <Section title="Tab / Table row / Menu item">
        <div role="tablist" aria-label="Demo tabs" className="flex gap-4 border-b border-border">
          {['a', 'b', 'c'].map((id) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={tab === id}
              data-selected={tab === id}
              onClick={() => setTab(id)}
              className={`focus-ring px-3 py-2 text-sm font-medium transition-colors duration-fast ${surfaceClass('tab')}`}
            >
              Tab {id.toUpperCase()}
            </button>
          ))}
        </div>
        <table className="w-full text-start text-sm">
          <tbody>
            {['r1', 'r2', 'r3'].map((id) => (
              <tr
                key={id}
                tabIndex={0}
                data-selected={picked === id}
                aria-selected={picked === id}
                onClick={() => setPicked(id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setPicked(id)}
                className={`focus-ring cursor-pointer border-b border-border transition-colors duration-fast ${surfaceClass('row')}`}
              >
                <td className="px-3 py-2 text-text-primary">Row {id}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div role="menu" aria-label="Demo menu" className="w-48 rounded-xl border border-border bg-bg-secondary p-1">
          {['Edit', 'Duplicate', 'Archive'].map((label, i) => (
            <button
              key={label}
              role="menuitem"
              type="button"
              data-selected={i === 0}
              className={`focus-ring block w-full rounded-lg px-3 py-2 text-start text-sm transition-colors duration-fast ${surfaceClass('menuItem')}`}
            >
              {label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Card">
        <div className="grid gap-6 md:grid-cols-3">
          <Card className="!p-5" interactive={false}>
            Static (no hover lift)
          </Card>
          <Card className="!p-5" onClick={() => toast('Card opened', 'info')}>
            Interactive (click / Enter)
          </Card>
          <Card className="!p-5" selected onClick={() => undefined}>
            Selected
          </Card>
        </div>
      </Section>

      <Section title="Copy">
        <div className="flex flex-wrap gap-4">
          <CopyButton text="vrk_live_example_key" />
          <CopyButton text="vrk_live_example_key" variant="ghost" label="Copy key" />
          <IconButton label="Copy (icon only)" icon={Copy} onClick={() => undefined} />
        </div>
      </Section>

      <Section title="Feedback levels">
        <p className="text-sm text-text-secondary">
          Inline check: the user is looking at the control. Toast: a background result. Banner: a persistent page-level condition.
          Full success state: a completed multi-step flow.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" size="sm" onClick={() => toast('Changes saved', 'success')}>Success</Button>
          <Button variant="secondary" size="sm" onClick={() => toast('Heads up: trial ends in 3 days', 'warning')}>Warning</Button>
          <Button variant="secondary" size="sm" onClick={() => toast('Sync started', 'info')}>Info</Button>
          <Button variant="secondary" size="sm" onClick={() => toast('Could not save', 'error', { action: { label: 'Retry', onClick: () => undefined } })}>Error + action</Button>
          <Button variant="secondary" size="sm" onClick={() => { for (let i = 0; i < 5; i++) toast(`Burst ${i}`, 'info'); }}>Queue (5)</Button>
        </div>
      </Section>
    </main>
  );
}
