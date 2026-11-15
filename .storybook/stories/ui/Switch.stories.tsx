import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { Switch, type SwitchProps } from '@/components/ui/Switch';
import { demo } from '../../demoText';

const meta = {
  title: 'UI/Switch',
  component: Switch,
  tags: ['autodocs'],
  args: { checked: false, label: 'SMS notifications', onChange: fn() },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

// Switch is fully controlled, so stories keep the state locally and still report to the Actions panel.
function Controlled(props: SwitchProps) {
  const [checked, setChecked] = useState(props.checked);
  return (
    <Switch
      {...props}
      checked={checked}
      onChange={(next) => {
        setChecked(next);
        props.onChange(next);
      }}
    />
  );
}

export const Off: Story = {
  render: (args, { globals }) => <Controlled {...args} label={demo(globals).notify} />,
};

export const On: Story = {
  args: { checked: true },
  render: (args, { globals }) => <Controlled {...args} label={demo(globals).notify} />,
};

export const WithHint: Story = {
  render: (args, { globals }) => (
    <Controlled {...args} label={demo(globals).notify} hint={demo(globals).notifyHint} />
  ),
};

export const Loading: Story = {
  args: { loading: true, checked: true },
  render: (args, { globals }) => <Controlled {...args} label={demo(globals).notify} />,
};

// The reason is shown inline, visible to everyone without hovering.
export const DisabledWithReason: Story = {
  args: { disabled: true },
  render: (args, { globals }) => (
    <Controlled {...args} label={demo(globals).notify} disabledReason={demo(globals).noPermission} />
  ),
};
