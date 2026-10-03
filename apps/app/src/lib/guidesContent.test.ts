import { expect, it } from 'vitest';
import { GUIDE_CONTENT } from './guidesContent.js';

it('explains the installed-plugin submission path and review before sending', () => {
  expect(GUIDE_CONTENT['create-extension']).toContain('More plugin actions → Submit to');
  expect(GUIDE_CONTENT['create-extension']).toContain('submit-a-plugin');
  expect(GUIDE_CONTENT['create-extension']).toContain('Review it and send it');
  expect(GUIDE_CONTENT['create-extension']).toContain('approval after preparing the work');
});
