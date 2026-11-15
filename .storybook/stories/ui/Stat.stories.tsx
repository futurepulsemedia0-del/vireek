import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stat } from '@/components/ui/Stat';
import { demo } from '../../demoText';

const meta = {
  title: 'UI/Stat',
  component: Stat,
  tags: ['autodocs'],
  args: { label: 'Monthly revenue', value: '$12,480' },
  argTypes: { delta: { control: false }, sparkline: { control: 'object' } },
} satisfies Meta<typeof Stat>;

export default meta;
type Story = StoryObj<typeof meta>;

const SERIES = [4, 6, 5, 9, 8, 12, 11, 14];

// `value` is pre-formatted in the app (@/lib/format); here it is demo copy.
export const Default: Story = {
  render: (args, { globals }) => (
    <Stat {...args} label={demo(globals).revenue} value={demo(globals).revenueValue} />
  ),
};

export const WithSparkline: Story = {
  args: { sparkline: SERIES },
  render: (args, { globals }) => (
    <Stat {...args} label={demo(globals).revenue} value={demo(globals).revenueValue} />
  ),
};

export const WithDelta: Story = {
  args: { sparkline: SERIES },
  render: (args, { globals }) => (
    <Stat
      {...args}
      label={demo(globals).revenue}
      value={demo(globals).revenueValue}
      delta={<span>+8.2%</span>}
    />
  ),
};

export const WithDefinition: Story = {
  render: (args, { globals }) => (
    <Stat
      {...args}
      label={demo(globals).revenue}
      value={demo(globals).revenueValue}
      definition={demo(globals).revenueDefinition}
    />
  ),
};

export const Loading: Story = {
  args: { loading: true },
  render: (args, { globals }) => (
    <Stat {...args} label={demo(globals).revenue} value={demo(globals).revenueValue} />
  ),
};
