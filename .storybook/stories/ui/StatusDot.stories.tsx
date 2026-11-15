import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusDot } from '@/components/ui/StatusDot';
import { demo } from '../../demoText';

const meta = {
  title: 'UI/StatusDot',
  component: StatusDot,
  tags: ['autodocs'],
  args: { label: 'Online', tone: 'success' },
  argTypes: { tone: { control: 'inline-radio', options: ['neutral', 'success', 'warning', 'danger', 'live'] } },
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args, { globals }) => <StatusDot {...args} label={demo(globals).online} />,
};

// Colour is never the only carrier of meaning: every tone has a visible text label.
export const AllTones: Story = {
  render: (_args, { globals }) => (
    <div style={{ display: 'grid', gap: 12 }}>
      <StatusDot tone="success" label={demo(globals).online} />
      <StatusDot tone="warning" label={demo(globals).warning} />
      <StatusDot tone="danger" label={demo(globals).failed} />
      <StatusDot tone="live" label={demo(globals).live} />
      <StatusDot tone="neutral" label={demo(globals).idle} />
    </div>
  ),
};
