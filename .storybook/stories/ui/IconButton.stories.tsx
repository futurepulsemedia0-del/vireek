import type { Meta, StoryObj } from '@storybook/react-vite';
import { Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import { fn } from 'storybook/test';
import { IconButton } from '@/components/ui/IconButton';
import { demo } from '../../demoText';
import { Row } from '../../layout';

const meta = {
  title: 'UI/IconButton',
  component: IconButton,
  tags: ['autodocs'],
  args: { label: 'Edit', icon: Pencil, size: 'md', onClick: fn() },
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'ghost', 'danger'] },
    size: { control: 'inline-radio', options: ['xs', 'sm', 'md', 'lg'] },
    density: { control: 'inline-radio', options: ['comfortable', 'dense'] },
    icon: { control: false },
  },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

// `label` is the accessible name and the tooltip, so every story passes translated text.
export const Playground: Story = {
  render: (args, { globals }) => <IconButton {...args} label={demo(globals).edit} />,
};

export const Variants: Story = {
  render: (args, { globals }) => (
    <Row>
      <IconButton {...args} variant="primary" icon={Plus} label={demo(globals).add} />
      <IconButton {...args} variant="secondary" icon={Settings} label={demo(globals).settings} />
      <IconButton {...args} variant="ghost" icon={Pencil} label={demo(globals).edit} />
      <IconButton {...args} variant="danger" icon={Trash2} label={demo(globals).remove} />
    </Row>
  ),
};

export const Sizes: Story = {
  render: (args, { globals }) => (
    <Row>
      {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
        <IconButton key={size} {...args} size={size} label={demo(globals).edit} />
      ))}
    </Row>
  ),
};

export const Dense: Story = {
  args: { density: 'dense' },
  render: (args, { globals }) => (
    <Row>
      <IconButton {...args} icon={Pencil} label={demo(globals).edit} />
      <IconButton {...args} icon={Trash2} label={demo(globals).remove} />
    </Row>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args, { globals }) => <IconButton {...args} label={demo(globals).edit} />,
};
