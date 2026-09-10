/**
 * RuleTester regression suite for the `tagnest/*` design-system rules.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `tagnest/no-magic-tokens` shipped for months emitting **zero** messages
 * (audit finding G-01). Its `classFragments()` handled only `Literal` and
 * `TemplateLiteral`, so every `className={cx(...)}` — which is how all ten
 * `ui/` primitives express their variant tables — resolved to `[]`. The rule
 * looked green because it was blind, and nothing caught it.
 *
 * The three probes below are the exact cases that used to pass silently. They
 * are pinned here so the traversal can never regress again:
 *
 *   1. `className={cx('bg-surface/85')}`                     -> 1 semiSurface
 *   2. `className={cx('bg-surface/85', 'backdrop-blur-sm')}` -> 0 (glass exemption)
 *   3. `const X = 'text-[10px]'; <div className={X} />`      -> 1 magicValue
 *
 * RUN
 * ---
 *   node tools/eslint/no-magic-tokens.test.mjs
 *
 * RuleTester falls back to its own synchronous describe/it handlers when no
 * test framework globals are present, so the file is directly executable. It is
 * deliberately NOT matched by `vitest.ui.config.ts` (`src/**`) or
 * `vitest.backend.config.ts` (`tests/**`) — it lives with the rules it tests.
 */

import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';

import noMagicTokens from './no-magic-tokens.js';
import noOffscaleTokens, { BANNED } from './no-offscale-tokens.js';
import requireFocusRing from './require-focus-ring.js';
import { stripVariants } from './_class-fragments.js';

/** Mirrors the `**\/*.{ts,tsx}` block of eslint.config.js. */
const languageOptions = {
  parser: tsParser,
  parserOptions: { ecmaFeatures: { jsx: true } },
};

const ruleTester = new RuleTester({ languageOptions });

/**
 * Wrap a JSX snippet in a minimal module so it parses standalone.
 *
 * `cx` is intentionally left undefined: RuleTester runs only the rule under
 * test, so `no-undef` never fires and the call shape is all the rule needs.
 *
 * @param {string} body JSX statement(s).
 * @return {string} A parseable module source string.
 */
function component(body) {
  return `const A = () => (${body});\n`;
}

/**
 * Build the expected `offscale` report for one token.
 *
 * The remediation text lives in the rule's `BANNED` table, so the expectation
 * is derived from it rather than duplicated here — otherwise a wording tweak in
 * the rule would break every test without any behaviour change.
 *
 * @param {string} cls The token as written in source (may carry variants).
 * @return {{messageId: string, data: {cls: string, fix: string}}}
 */
function off(cls) {
  const base = stripVariants(cls);
  const fix = BANNED.get(base);
  if (!fix) throw new Error(`test bug: "${base}" is not in BANNED`);
  return { messageId: 'offscale', data: { cls, fix } };
}

/* ====================================================================== *
 * tagnest/no-magic-tokens
 * ====================================================================== */

const magicValid = [
  // Plain tokenised utilities.
  { code: component('<div className="bg-surface rounded-lg p-4 text-sm" />') },
  // PROBE 2 — frosted glass: a backdrop-blur sibling legitimises the opacity.
  // Split across two cx() arguments on purpose: the exemption must be judged
  // over the whole attribute, not per fragment.
  { code: component("<div className={cx('bg-surface/85', 'backdrop-blur-sm')} />") },
  { code: component('<div className="bg-surface/85 backdrop-blur-sm" />') },
  { code: component("<div className={cx('bg-black/45 backdrop-blur-[6px]')} />") },
  // Runtime CSS variables are the dynamic-theming contract, not magic values.
  { code: component('<div className="bg-[var(--tag-dot)] text-[var(--tag-fg)]" />') },
  { code: component('<div className="ring-[--tag-dot]" />') },
  // Gradient stops keep raw opacity by design (SEMI_ALLOWLIST).
  { code: component('<div className="from-brand/40 via-brand/20 to-transparent" />') },
  { code: component("<div className={cx('from-white/10', 'to-black/30')} />") },
  // Layout/position arbitrary values are out of the token contract's scope.
  { code: component('<div className="w-[252px] max-w-[92dvh] grid-cols-[1fr_2fr] z-[70]" />') },
  // Unresolvable expressions must stay silent rather than guess.
  { code: component('<div className={classes} />') },
  { code: component('<div className={props.className} />') },
  { code: component('<div className={cx(base, ...rest)} />') },
  { code: component('<div className={`h-full ${dynamic}`} />') },
  // Opaque semantic tokens introduced by the design system.
  { code: component('<div className="bg-glass-raised bg-glass-solid bg-scrim border-line-soft" />') },
  // Not a className attribute.
  { code: component('<div class="bg-surface/85" />') },
  { code: component('<div id="bg-surface/85" />') },
];

const magicInvalid = [
  // PROBE 1 — the regression that made the whole gate blind.
  {
    code: component("<div className={cx('bg-surface/85')} />"),
    errors: [{ messageId: 'semiSurface', data: { cls: 'bg-surface/85' } }],
  },
  // PROBE 3 — module-level string constant referenced by identifier.
  {
    code: "const X = 'text-[10px]';\nconst A = () => <div className={X} />;\n",
    errors: [{ messageId: 'magicValue', data: { cls: 'text-[10px]' } }],
  },
  // The original literal path must keep working. Errors are reported in token
  // order, and all share one node, so the expected list follows the source.
  {
    code: component('<div className="bg-surface/85 text-[10px] p-[13px] rounded-[7px]" />'),
    errors: [
      { messageId: 'semiSurface', data: { cls: 'bg-surface/85' } },
      { messageId: 'magicValue', data: { cls: 'text-[10px]' } },
      { messageId: 'magicValue', data: { cls: 'p-[13px]' } },
      { messageId: 'magicValue', data: { cls: 'rounded-[7px]' } },
    ],
  },
  // The four real cx()-hidden violations from audit G-01.
  {
    code: component("<div className={cx('rounded-[5px]', 'bg-[length:14px]', 'bg-[right_0.6rem_center]')} />"),
    errors: [
      { messageId: 'magicValue', data: { cls: 'rounded-[5px]' } },
      { messageId: 'magicValue', data: { cls: 'bg-[length:14px]' } },
      { messageId: 'magicValue', data: { cls: 'bg-[right_0.6rem_center]' } },
    ],
  },
  // Variant lookup table: VARIANT[variant] exposes every value as a candidate.
  {
    code:
      "const VARIANT = { primary: 'bg-brand/20 shadow-raised', ghost: 'text-ink' };\n" +
      component('<div className={cx(VARIANT[variant])} />'),
    errors: [{ messageId: 'semiSurface', data: { cls: 'bg-brand/20' } }],
  },
  // `+`-concatenated constant (the shape of Field.tsx:57-62 CONTROL_BASE).
  {
    code:
      "const CONTROL_BASE = 'w-full bg-surface rounded-md ' + 'focus:ring-2 focus:ring-brand/25';\n" +
      component('<input className={cx(CONTROL_BASE)} />'),
    errors: [{ messageId: 'semiSurface', data: { cls: 'focus:ring-brand/25' } }],
  },
  // `as const` table (the shape of Field.tsx:81-85 INPUT_SIZE).
  {
    code:
      "const SIZE = { sm: 'bg-sunken/40', md: 'text-xs' } as const;\n" +
      component('<div className={cx(SIZE[size])} />'),
    errors: [{ messageId: 'semiSurface', data: { cls: 'bg-sunken/40' } }],
  },
  // Conditional expression: both branches are candidates.
  {
    code: component("<div className={ok ? 'bg-surface/85' : 'text-[10px]'} />"),
    errors: [
      { messageId: 'semiSurface', data: { cls: 'bg-surface/85' } },
      { messageId: 'magicValue', data: { cls: 'text-[10px]' } },
    ],
  },
  // Logical expression.
  {
    code: component("<div className={ok && 'border-line/70'} />"),
    errors: [{ messageId: 'semiSurface', data: { cls: 'border-line/70' } }],
  },
  // Array expression.
  {
    code: component("<div className={['bg-sunken/60', 'ring-brand/50']} />"),
    errors: [
      { messageId: 'semiSurface', data: { cls: 'bg-sunken/60' } },
      { messageId: 'semiSurface', data: { cls: 'ring-brand/50' } },
    ],
  },
  // G-02: the 21 families the old /^bg-surface\// could not see.
  {
    code: component(
      '<div className="bg-brand-soft/30 bg-sunken/60 border-line/70 ring-brand/30 text-white/70 bg-black/50" />',
    ),
    errors: [
      { messageId: 'semiSurface', data: { cls: 'bg-brand-soft/30' } },
      { messageId: 'semiSurface', data: { cls: 'bg-sunken/60' } },
      { messageId: 'semiSurface', data: { cls: 'border-line/70' } },
      { messageId: 'semiSurface', data: { cls: 'ring-brand/30' } },
      { messageId: 'semiSurface', data: { cls: 'text-white/70' } },
      { messageId: 'semiSurface', data: { cls: 'bg-black/50' } },
    ],
  },
  // Variant-prefixed opacity must be seen too (13 of the 112 real sites).
  {
    code: component('<div className="hover:bg-brand/20 focus-visible:ring-brand/30" />'),
    errors: [
      { messageId: 'semiSurface', data: { cls: 'hover:bg-brand/20' } },
      { messageId: 'semiSurface', data: { cls: 'focus-visible:ring-brand/30' } },
    ],
  },
  // Variant-prefixed arbitrary value.
  {
    code: component('<div className="md:pl-[4.25rem] lg:pl-[15.75rem]" />'),
    errors: [
      { messageId: 'magicValue', data: { cls: 'md:pl-[4.25rem]' } },
      { messageId: 'magicValue', data: { cls: 'lg:pl-[15.75rem]' } },
    ],
  },
  // Arbitrary variant wrapping a semi-transparent value.
  {
    code: component('<div className="data-[state=open]:bg-surface/85" />'),
    errors: [{ messageId: 'semiSurface', data: { cls: 'data-[state=open]:bg-surface/85' } }],
  },
  // Template literal static quasis are still inspected (token order preserved).
  {
    code: 'const A = () => <div className={`bg-surface/85 rounded-[7px] ${dyn}`} />;\n',
    errors: [
      { messageId: 'semiSurface', data: { cls: 'bg-surface/85' } },
      { messageId: 'magicValue', data: { cls: 'rounded-[7px]' } },
    ],
  },
  // Nested cx() calls.
  {
    code: component("<div className={cx('flex', cx('bg-surface/85'), cx('text-[10px]'))} />"),
    errors: [
      { messageId: 'semiSurface', data: { cls: 'bg-surface/85' } },
      { messageId: 'magicValue', data: { cls: 'text-[10px]' } },
    ],
  },
  // A blur sibling in a DIFFERENT attribute must not exempt this one.
  {
    code: component("<div className=\"backdrop-blur-sm\"><span className={cx('bg-surface/85')} /></div>"),
    errors: [{ messageId: 'semiSurface', data: { cls: 'bg-surface/85' } }],
  },
];

/* ====================================================================== *
 * tagnest/no-offscale-tokens
 * ====================================================================== */

const offscaleValid = [
  // The six tokenised radius steps.
  { code: component('<div className="rounded-xs rounded-sm rounded-md rounded-lg rounded-xl rounded-2xl rounded-full" />') },
  // Scaled corner forms are fine — only the BARE corner forms are off-scale.
  { code: component('<div className="rounded-t-lg rounded-t-2xl rounded-t-sm rounded-b-md" />') },
  // Decision D2: the old four-step ladder plus glow is the only semantic one.
  { code: component('<div className="shadow-raised shadow-float shadow-overlay shadow-modal shadow-glow" />') },
  // Decision D1: the formalised 2xs..2xl type scale.
  { code: component('<div className="text-2xs text-xs text-sm text-base text-lg text-xl text-2xl" />') },
  // Variant prefixes on legal utilities stay legal.
  { code: component('<div className="hover:shadow-raised md:rounded-lg focus:rounded-md" />') },
  // Unrelated utilities that merely start with a banned prefix.
  { code: component('<div className="rounded-md shadow-none text-left shadow-raised" />') },
  { code: component('<div className={classes} />') },
];

const offscaleInvalid = [
  // R-01: bare `rounded` is the off-ladder 4px seventh step (34 real sites).
  {
    code: component('<div className="rounded bg-surface" />'),
    errors: [off('rounded')],
  },
  {
    code: component("<div className={cx('shrink-0 rounded text-ink-faint')} />"),
    errors: [off('rounded')],
  },
  // Variant prefixes are stripped before matching.
  {
    code: component('<div className="hover:rounded md:rounded" />'),
    errors: [off('hover:rounded'), off('md:rounded')],
  },
  // Bare corner forms.
  {
    code: component('<div className="rounded-t rounded-br" />'),
    errors: [off('rounded-t'), off('rounded-br')],
  },
  // R-02: bare Tailwind shadow (black base) and the demoted private steps.
  {
    code: component('<div className="shadow bg-surface" />'),
    errors: [off('shadow')],
  },
  {
    code: component('<div className="shadow-sm rounded-full text-white" />'),
    errors: [off('shadow-sm')],
  },
  {
    code: component('<div className="shadow-xs rounded-md bg-surface" />'),
    errors: [off('shadow-xs')],
  },
  {
    code: component('<div className="shadow-lg" />'),
    errors: [off('shadow-lg')],
  },
  // T-01 / decision D1: the retired semantic type scale.
  {
    code: component('<div className="text-display text-h1 text-h2 text-h3 text-body text-caption" />'),
    errors: [
      off('text-display'),
      off('text-h1'),
      off('text-h2'),
      off('text-h3'),
      off('text-body'),
      off('text-caption'),
    ],
  },
  // Off-scale tokens hidden inside a module-level variant table.
  {
    code:
      "const SIZE = { sm: 'h-7 w-7 rounded', md: 'h-9 w-9 rounded-lg' };\n" +
      component('<button className={cx(SIZE[size])}>x</button>'),
    errors: [off('rounded')],
  },
  // Multiple offenders in one cx().
  {
    code: component("<div className={cx('rounded', 'shadow-sm', 'text-caption')} />"),
    errors: [off('rounded'), off('shadow-sm'), off('text-caption')],
  },
];

/* ====================================================================== *
 * tagnest/require-focus-ring
 * ====================================================================== */

const focusValid = [
  // The L2 focus-ring utility family satisfies both checks.
  { code: component('<button className="focus-ring rounded-md">x</button>') },
  { code: component('<button className="focus-ring-round">x</button>') },
  { code: component('<input className="focus-ring-inset" />') },
  // A focus-visible ring utility satisfies both checks.
  {
    code: component(
      "<button className={cx('rounded-md', 'focus-visible:ring-2 focus-visible:ring-brand')}>x</button>",
    ),
  },
  // Outline removed but replaced in the same className -> hard rule satisfied.
  {
    code: component(
      '<button className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">x</button>',
    ),
  },
  {
    code: component('<div className="focus:outline-none focus:ring-2 focus:ring-brand" />'),
  },
  { code: component('<div className="outline-none focus-ring" />') },
  // `focus:` (not only `focus-visible:`) still paints an indicator.
  { code: component('<button className="outline-none focus:bg-surface">x</button>') },
  // Non-interactive elements are never asked for a ring.
  { code: component('<div className="rounded-lg p-4 bg-surface" />') },
  { code: component('<span className="bg-sunken text-xs">x</span>') },
  { code: component('<p className="text-sm">x</p>') },
  // Not focusable: hidden input, href-less anchor, inert role.
  { code: component('<input type="hidden" className="rounded" />') },
  { code: component('<a className="rounded-md">x</a>') },
  { code: component('<div role="presentation" className="rounded">x</div>') },
  // Out of the tab order / disabled: cannot receive keyboard focus.
  // `tabIndex={-1}` exempts BOTH checks — this is the skip-link destination
  // (AppLayout.tsx:92-95) and the modal panel (Modal.tsx:145-154) shape.
  { code: component('<div tabIndex={-1} className="rounded-lg outline-none" />') },
  { code: component('<main id="main" tabIndex={-1} className="mx-auto outline-none" />') },
  {
    code: component(
      "<div role=\"dialog\" aria-modal=\"true\" tabIndex={-1} className={cx('shadow-modal outline-none backdrop-blur-xl')} />",
    ),
  },
  { code: component('<button disabled className="rounded-md">x</button>') },
  { code: component('<button disabled={true} className="rounded-md">x</button>') },
  // Components inherit their ring from the primitive; call sites are not judged.
  { code: component('<Button className="rounded-md">x</Button>') },
  { code: component('<IconButton className="rounded-md" />') },
  // A className we cannot resolve statically is not judged.
  { code: component('<button className={classes}>x</button>') },
  { code: component('<button className={cx(base, className)}>x</button>') },
  // Ring supplied through a module-level constant is visible to the rule.
  {
    code:
      "const BASE = 'rounded-md focus-visible:ring-2 focus-visible:ring-brand';\n" +
      component('<button className={BASE}>x</button>'),
  },
];

const focusInvalid = [
  // HARD RULE — outline removed with nothing put back. Element-agnostic.
  {
    code: component('<div className="outline-none" />'),
    errors: [{ messageId: 'outlineNoneWithoutIndicator', data: { cls: 'outline-none' } }],
  },
  {
    code: component('<div className="min-w-0 flex-1 bg-transparent outline-none" />'),
    errors: [{ messageId: 'outlineNoneWithoutIndicator', data: { cls: 'outline-none' } }],
  },
  {
    code: component("<div className={cx('rounded-t-2xl shadow-modal outline-none backdrop-blur-xl')} />"),
    errors: [{ messageId: 'outlineNoneWithoutIndicator', data: { cls: 'outline-none' } }],
  },
  {
    code: component('<div className="focus:outline-none" />'),
    errors: [{ messageId: 'outlineNoneWithoutIndicator', data: { cls: 'focus:outline-none' } }],
  },
  {
    code: component('<div className="focus-visible:outline-hidden" />'),
    errors: [{ messageId: 'outlineNoneWithoutIndicator', data: { cls: 'focus-visible:outline-hidden' } }],
  },
  // Interactive element with an outline suppressor and no replacement: the hard
  // rule fires and check 2 is suppressed (same root cause, less specific
  // message). This is the Field.tsx:279 / Display.tsx:428 shape once the
  // low-contrast ring is removed in T03.
  {
    code: component('<button className="focus-visible:outline-none rounded-md">x</button>'),
    errors: [
      { messageId: 'outlineNoneWithoutIndicator', data: { cls: 'focus-visible:outline-none' } },
    ],
  },
  // ADVISORY RULE — focusable element declaring no indicator at all.
  {
    code: component('<button className="rounded-md bg-surface text-sm">x</button>'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'button' } }],
  },
  {
    code: component('<input className="rounded-md border border-line" />'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'input' } }],
  },
  {
    code: component('<select className="rounded-md" />'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'select' } }],
  },
  {
    code: component('<textarea className="rounded-md" />'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'textarea' } }],
  },
  // An anchor becomes focusable only with an href.
  {
    code: component('<a href="/x" className="rounded-md border border-line">y</a>'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'a' } }],
  },
  {
    code: component('<a href={url} target="_blank" rel="noreferrer" className="group flex">y</a>'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'a' } }],
  },
  // Interactive ARIA roles make an inert element focusable.
  {
    code: component('<span role="button" className="rounded-full">y</span>'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'span role="button"' } }],
  },
  {
    code: component('<div role="tab" className="rounded-lg">y</div>'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'div role="tab"' } }],
  },
  {
    code: component('<div role="menuitem" className="rounded-md">y</div>'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'div role="menuitem"' } }],
  },
  {
    code: component('<button role="switch" className="rounded-full border">y</button>'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'button' } }],
  },
  // Hidden inside cx() — the shape of every ui/ primitive.
  {
    code: component(
      "<button className={cx('inline-flex shrink-0 items-center', 'rounded-lg', 'bg-surface text-ink')}>x</button>",
    ),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'button' } }],
  },
  // Hidden inside a module-level variant table.
  {
    code:
      "const VARIANT = { ghost: 'text-ink-soft hover:bg-surface-hover' };\n" +
      component('<button className={cx(VARIANT[variant])}>x</button>'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'button' } }],
  },
  // A non-focus-state ring does not count as a focus indicator.
  {
    code: component('<button className="rounded-md ring-2 ring-brand/50">x</button>'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'button' } }],
  },
  // `disabled={expr}` is dynamic, so the element is still judged.
  {
    code: component('<button disabled={isBusy} className="rounded-md">x</button>'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'button' } }],
  },
  // tabIndex={0} keeps the element in the tab order.
  {
    code: component('<div tabIndex={0} role="checkbox" className="rounded">x</div>'),
    errors: [{ messageId: 'missingFocusRing', data: { tag: 'div role="checkbox"' } }],
  },
];

/* ====================================================================== *
 * Runner
 * ====================================================================== */

const suites = [
  ['tagnest/no-magic-tokens', noMagicTokens, magicValid, magicInvalid],
  ['tagnest/no-offscale-tokens', noOffscaleTokens, offscaleValid, offscaleInvalid],
  ['tagnest/require-focus-ring', requireFocusRing, focusValid, focusInvalid],
];

const totalValid = suites.reduce((n, s) => n + s[2].length, 0);
const totalInvalid = suites.reduce((n, s) => n + s[3].length, 0);
const totalErrors = suites.reduce(
  (n, s) => n + s[3].reduce((m, c) => m + (Array.isArray(c.errors) ? c.errors.length : 1), 0),
  0,
);

for (const [name, rule, valid, invalid] of suites) {
  ruleTester.run(name, rule, { valid, invalid });
}

// Reaching this line means every case passed: RuleTester throws on the first
// mismatch, so a silent exit is the success signal.
console.log(
  `tagnest eslint rules: ${suites.length} rules, ` +
    `${totalValid} valid + ${totalInvalid} invalid cases, ` +
    `${totalErrors} expected reports — ALL PASS`,
);
