/** @jsxRuntime automatic @jsxImportSource react */
import { composeStories } from '@storybook/react';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import preview from '../../.storybook/preview';
import * as approvalStories from './approval.stories';
import * as primitiveStories from './primitives.stories';
import * as runStories from './run.stories';
import * as tokenStories from './tokens.stories';

const all = {
  ...composeStories(tokenStories, preview),
  ...composeStories(primitiveStories, preview),
  ...composeStories(approvalStories, preview),
  ...composeStories(runStories, preview),
};

/** Every story renders and has no axe violations (contrast is checked in the browser e2e suite). */
describe('Storybook stories', () => {
  for (const [name, Story] of Object.entries(all)) {
    it(`${name} renders without a11y violations`, async () => {
      const { container, findAllByText } = render(<Story />);
      await findAllByText(/./);
      const r = await axe.run(container, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(
        r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      ).toEqual([]);
    });
  }
});
