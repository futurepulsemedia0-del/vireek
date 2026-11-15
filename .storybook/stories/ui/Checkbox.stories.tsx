import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Checkbox } from '@/components/ui/Checkbox';
import { demo } from '../../demoText';

const meta = {
  title: 'UI/Checkbox',
  component: Checkbox,
  tags: ['autodocs'],
  args: { label: 'I accept the terms', onChange: fn() },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args, { globals }) => <Checkbox {...args} label={demo(globals).terms} />,
};

export const Checked: Story = {
  args: { defaultChecked: true },
  render: (args, { globals }) => <Checkbox {...args} label={demo(globals).terms} />,
};

export const WithHelperText: Story = {
  render: (args, { globals }) => (
    <Checkbox {...args} label={demo(globals).terms} helperText={demo(globals).termsHint} />
  ),
};

export const WithError: Story = {
  render: (args, { globals }) => (
    <Checkbox {...args} label={demo(globals).terms} error={demo(globals).termsError} />
  ),
};

export const Indeterminate: Story = {
  args: { indeterminate: true },
  render: (args, { globals }) => <Checkbox {...args} label={demo(globals).terms} />,
};

// The reason is printed inline, so it never depends on hover.
export const DisabledWithReason: Story = {
  args: { disabled: true },
  render: (args, { globals }) => (
    <Checkbox {...args} label={demo(globals).terms} disabledReason={demo(globals).noPermission} />
  ),
};
