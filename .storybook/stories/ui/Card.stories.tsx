import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Card } from '@/components/ui/Card';
import { demo } from '../../demoText';
import { Stack } from '../../layout';

const meta = {
  title: 'UI/Card',
  component: Card,
  tags: ['autodocs'],
  args: { padding: 'md', interactive: false },
  argTypes: {
    padding: { control: 'inline-radio', options: ['none', 'sm', 'md', 'lg'] },
    children: { control: false },
  },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Static: Story = {
  render: (args, { globals }) => (
    <Card {...args}>
      <strong>{demo(globals).cardTitle}</strong>
      <p>{demo(globals).cardBody}</p>
    </Card>
  ),
};

// With onClick the card becomes role="button", focusable, and Enter/Space activate it.
export const Interactive: Story = {
  args: { interactive: true, onClick: fn() },
  render: (args, { globals }) => (
    <Card {...args}>
      <strong>{demo(globals).cardTitle}</strong>
      <p>{demo(globals).cardBody}</p>
    </Card>
  ),
};

export const Selected: Story = {
  args: { selected: true },
  render: (args, { globals }) => (
    <Card {...args}>
      <strong>{demo(globals).cardTitle}</strong>
      <p>{demo(globals).cardBody}</p>
    </Card>
  ),
};

export const WithError: Story = {
  args: { error: true },
  render: (args, { globals }) => (
    <Card {...args}>
      <strong>{demo(globals).cardTitle}</strong>
      <p>{demo(globals).emailError}</p>
    </Card>
  ),
};

export const Paddings: Story = {
  render: (args, { globals }) => (
    <Stack maxWidth={520}>
      {(['none', 'sm', 'md', 'lg'] as const).map((padding) => (
        <Card key={padding} {...args} padding={padding}>
          <strong>{padding}</strong> · {demo(globals).cardBody}
        </Card>
      ))}
    </Stack>
  ),
};
