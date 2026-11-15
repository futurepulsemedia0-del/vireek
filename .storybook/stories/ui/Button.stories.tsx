import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Button } from '@/components/ui/Button';
import { demo } from '../../demoText';
import { Row, Stack } from '../../layout';

const meta = {
  title: 'UI/Button',
  component: Button,
  tags: ['autodocs'],
  args: { variant: 'primary', size: 'md', onClick: fn() },
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'ghost', 'danger'] },
    size: { control: 'inline-radio', options: ['xs', 'sm', 'md', 'lg'] },
    tone: { control: 'inline-radio', options: ['default', 'cta'] },
    children: { control: false },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args, { globals }) => <Button {...args}>{demo(globals).save}</Button>,
};

export const Variants: Story = {
  render: (args, { globals }) => (
    <Row>
      {(['primary', 'secondary', 'ghost', 'danger'] as const).map((variant) => (
        <Button key={variant} {...args} variant={variant}>
          {variant === 'danger' ? demo(globals).remove : demo(globals).save}
        </Button>
      ))}
    </Row>
  ),
};

export const Sizes: Story = {
  render: (args, { globals }) => (
    <Row>
      {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
        <Button key={size} {...args} size={size}>
          {demo(globals).save}
        </Button>
      ))}
    </Row>
  ),
};

export const CallToAction: Story = {
  args: { tone: 'cta' },
  render: (args, { globals }) => <Button {...args}>{demo(globals).save}</Button>,
};

export const Loading: Story = {
  args: { loading: true },
  render: (args, { globals }) => <Button {...args}>{demo(globals).save}</Button>,
};

export const DisabledWithReason: Story = {
  args: { disabled: true },
  render: (args, { globals }) => (
    <Button {...args} disabledReason={demo(globals).noPermission}>
      {demo(globals).save}
    </Button>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args, { globals }) => <Button {...args}>{demo(globals).save}</Button>,
};

export const FullWidth: Story = {
  args: { fullWidth: true },
  render: (args, { globals }) => (
    <Stack>
      <Button {...args}>{demo(globals).save}</Button>
    </Stack>
  ),
};
