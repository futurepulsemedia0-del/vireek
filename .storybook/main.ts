import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['./stories/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-docs'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  // Storybook reuses vite.config.ts (alias "@", PostCSS/Tailwind). The blog plugin validates
  // content/blog at build start and is irrelevant here, so it is dropped.
  viteFinal: async (viteConfig) => ({
    ...viteConfig,
    plugins: (viteConfig.plugins ?? []).filter(
      (plugin) => !(plugin && !Array.isArray(plugin) && 'name' in plugin && plugin.name === 'vireek-blog'),
    ),
  }),
};

export default config;
