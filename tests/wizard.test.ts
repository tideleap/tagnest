// tests/wizard.test.ts
//
// CS-P4-3 (C5-1) pairing-wizard progression. The wizard must walk steps in
// strict order and never skip ahead, even when later flags are somehow set.

import { describe, it, expect } from 'vitest';
import { wizardStep, wizardDone } from '../extension/bg/wizard.js';

describe('wizardStep — CS-P4-3 pairing progression', () => {
  it('starts at step 1 when nothing is configured', () => {
    expect(wizardStep({})).toBe(1);
    expect(wizardStep()).toBe(1);
  });

  it('stays on step 1 until configured, even if later flags are set', () => {
    expect(wizardStep({ configured: false, tested: true, built: true })).toBe(1);
  });

  it('advances to step 2 once configured', () => {
    expect(wizardStep({ configured: true })).toBe(2);
  });

  it('advances to step 3 once configured and tested', () => {
    expect(wizardStep({ configured: true, tested: true })).toBe(3);
  });

  it('reaches step 4 only after all three steps', () => {
    expect(wizardStep({ configured: true, tested: true, built: true })).toBe(4);
  });

  it('never skips ahead when an earlier step is missing', () => {
    expect(wizardStep({ configured: true, tested: false, built: true })).toBe(2);
  });
});

describe('wizardDone — CS-P4-3 completion', () => {
  it('is false until every step succeeded', () => {
    expect(wizardDone({ configured: true, tested: true })).toBe(false);
  });

  it('is true once configured, tested and built', () => {
    expect(wizardDone({ configured: true, tested: true, built: true })).toBe(true);
  });
});
