import type { Meta, StoryObj } from '@storybook/react-vite';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { demo } from '../../demoText';
import { Stack } from '../../layout';

const meta = {
  title: 'UI/Input',
  component: Input,
  tags: ['autodocs'],
  args: { label: 'Email', type: 'text' },
  argTypes: { icon: { control: false }, endAdornment: { control: false }, popup: { control: false } },
  decorators: [(Story) => <Stack><Story /></Stack>],
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args, { globals }) => (
    <Input {...args} label={demo(globals).email} helperText={demo(globals).emailHint} />
  ),
};

export const Required: Story = {
  args: { required: true },
  render: (args, { globals }) => <Input {...args} label={demo(globals).email} />,
};

export const WithError: Story = {
  args: { defaultValue: 'not-an-email' },
  render: (args, { globals }) => (
    <Input {...args} label={demo(globals).email} error={demo(globals).emailError} />
  ),
};

export const WithIcon: Story = {
  render: (args, { globals }) => (
    <Input {...args} icon={Search} label={demo(globals).search} placeholder={demo(globals).search} />
  ),
};

export const WithEndAdornment: Story = {
  args: { inputMode: 'decimal', defaultValue: '8.5' },
  render: (args, { globals }) => <Input {...args} label={demo(globals).revenue} endAdornment="%" />,
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'name@example.com' },
  render: (args, { globals }) => <Input {...args} label={demo(globals).email} />,
};
