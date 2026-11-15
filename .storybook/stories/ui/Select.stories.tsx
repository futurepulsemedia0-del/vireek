import type { Meta, StoryObj } from '@storybook/react-vite';
import { Select } from '@/components/ui/Select';
import { demo } from '../../demoText';
import { Stack } from '../../layout';

const meta = {
  title: 'UI/Select',
  component: Select,
  tags: ['autodocs'],
  args: { label: 'City' },
  argTypes: { children: { control: false } },
  decorators: [(Story) => <Stack><Story /></Stack>],
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

const Options = ({ globals }: { globals: Record<string, unknown> }) => (
  <>
    <option value="a">{demo(globals).cityA}</option>
    <option value="b">{demo(globals).cityB}</option>
    <option value="c">{demo(globals).cityC}</option>
  </>
);

export const Default: Story = {
  render: (args, { globals }) => (
    <Select {...args} label={demo(globals).city} helperText={demo(globals).cityHint}>
      <Options globals={globals} />
    </Select>
  ),
};

export const Required: Story = {
  args: { required: true },
  render: (args, { globals }) => (
    <Select {...args} label={demo(globals).city}>
      <Options globals={globals} />
    </Select>
  ),
};

export const WithError: Story = {
  render: (args, { globals }) => (
    <Select {...args} label={demo(globals).city} error={demo(globals).emailError}>
      <Options globals={globals} />
    </Select>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args, { globals }) => (
    <Select {...args} label={demo(globals).city}>
      <Options globals={globals} />
    </Select>
  ),
};
