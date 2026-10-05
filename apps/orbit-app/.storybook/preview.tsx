/** @jsxRuntime automatic @jsxImportSource react */
import type { Preview } from '@storybook/react-vite';
import { withRouter } from '../src/stories/decorators';
import '../src/styles.css';

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Colour theme',
      toolbar: { title: 'Theme', items: ['light', 'dark'], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: 'light' },
  decorators: [
    withRouter,
    (Story, ctx) => {
      document.documentElement.setAttribute('data-theme', String(ctx.globals.theme ?? 'light'));
      return (
        <div className="bg-bg p-6 text-fg">
          <Story />
        </div>
      );
    },
  ],
  parameters: { layout: 'fullscreen', controls: { expanded: true } },
};

export default preview;
