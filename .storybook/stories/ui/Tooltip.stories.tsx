import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { demo } from '../../demoText';

const meta = {
  title: 'UI/Tooltip',
  component: Tooltip,
  tags: ['autodocs'],
  args: { content: 'This action cannot be undone.', side: 'top', delayMs: 500, children: <span /> },
  argTypes: {
    side: { control: 'inline-radio', options: ['top', 'bottom'] },
    children: { control: false },
    content: { control: 'text' },
  },
  // Tooltips open on hover/focus, so leave room above and below the trigger.
  decorators: [(Story) => <div style={{ padding: '80px 0' }}><Story /></div>],
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Top: Story = {
  render: (args, { globals }) => (
    <Tooltip {...args} content={demo(globals).tooltip}>
      <Button variant="secondary">{demo(globals).remove}</Button>
    </Tooltip>
  ),
};

export const Bottom: Story = {
  args: { side: 'bottom' },
  render: (args, { globals }) => (
    <Tooltip {...args} content={demo(globals).tooltip}>
      <Button variant="secondary">{demo(globals).remove}</Button>
    </Tooltip>
  ),
};

export const InstantOpen: Story = {
  args: { delayMs: 0 },
  render: (args, { globals }) => (
    <Tooltip {...args} content={demo(globals).tooltip}>
      <Button variant="secondary">{demo(globals).remove}</Button>
    </Tooltip>
  ),
};

export const OpenOnTap: Story = {
  args: { openOnTap: true },
  render: (args, { globals }) => (
    <Tooltip {...args} content={demo(globals).tooltip}>
      <Button variant="secondary">{demo(globals).remove}</Button>
    </Tooltip>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args, { globals }) => (
    <Tooltip {...args} content={demo(globals).tooltip}>
      <Button variant="secondary">{demo(globals).remove}</Button>
    </Tooltip>
  ),
};
