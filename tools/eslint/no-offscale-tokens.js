/**
 * tagnest/no-offscale-tokens
 *
 * Sibling guard to `no-magic-tokens`. Where that rule polices *arbitrary*
 * values (`rounded-[5px]`, `bg-[#fff]`), this one polices **off-scale named
 * utilities** — tokens that exist in Tailwind's default theme but sit outside
 * TagNest's declared ladder, so they silently reintroduce a seventh step.
 *
 * Audit findings covered:
 *   - R-01: bare `rounded` (Tailwind default 4px) is used 40× and is not one of
 *     the six `--radius-*` steps. Same for the bare corner forms (`rounded-t`…).
 *   - R-02: two shadow ladders run in parallel. Decision D2 keeps the old four
 *     (`raised`/`float`/`overlay`/`modal`) plus `glow` as the only semantic
 *     ladder; `--shadow-xs` / `--shadow-sm` are demoted to `CategoryView.css`
 *     private and are banned from `.tsx`. `--shadow-lg` is dead (0 usages).
 *     The bare Tailwind `shadow` uses a black base inconsistent with the
 *     warm-grey `rgb(16 14 10 / …)` ladder.
 *   - T-01: the semantic type scale (`text-display`/`h1`/`h2`/`h3`/`body`/
 *     `caption`) has 0% adoption and is retired by decision D1 in favour of the
 *     existing `2xs…2xl` scale.
 *
 * `src/components/library/CategoryView.tsx` is exempted via an override in
 * `eslint.config.js` (decision D2 — it is the sole consumer of the private
 * `xs`/`sm` shadow steps, together with its colocated `CategoryView.css`).
 */

import {
  allTokens,
  classFragments,
  createConstScope,
  stripVariants,
} from './_class-fragments.js';

/**
 * Off-scale utility -> why it is banned and what to use instead.
 *
 * Keys are matched against the token **after** variant prefixes are stripped,
 * so `hover:rounded` and `md:rounded-t` are caught by the same entries as
 * `rounded` / `rounded-t`.
 *
 * @type {Map<string, string>}
 */
export const BANNED = new Map([
  // ---- R-01 · radius -----------------------------------------------------
  ['rounded', 'Use rounded-xs (4px, tokenised) instead of the bare Tailwind default.'],
  ['rounded-t', 'Use rounded-t-xs / rounded-t-lg explicitly.'],
  ['rounded-b', 'Use rounded-b-xs / rounded-b-lg explicitly.'],
  ['rounded-l', 'Use rounded-l-xs / rounded-l-lg explicitly.'],
  ['rounded-r', 'Use rounded-r-xs / rounded-r-lg explicitly.'],
  ['rounded-tl', 'Use rounded-tl-xs / rounded-tl-lg explicitly.'],
  ['rounded-tr', 'Use rounded-tr-xs / rounded-tr-lg explicitly.'],
  ['rounded-bl', 'Use rounded-bl-xs / rounded-bl-lg explicitly.'],
  ['rounded-br', 'Use rounded-br-xs / rounded-br-lg explicitly.'],

  // ---- R-02 · elevation --------------------------------------------------
  [
    'shadow',
    'Use shadow-raised. The bare Tailwind shadow uses a black base inconsistent with the warm-grey ladder.',
  ],
  ['shadow-xs', 'shadow-xs is private to CategoryView.css. In .tsx use shadow-raised.'],
  [
    'shadow-sm',
    'shadow-sm is private to CategoryView.css. In .tsx use shadow-raised / shadow-float.',
  ],
  ['shadow-lg', 'shadow-lg was removed (0 usages). Use shadow-overlay / shadow-modal.'],

  // ---- T-01 · retired semantic type scale (decision D1) ------------------
  [
    'text-display',
    'The semantic type scale was retired (0% adoption). Use atelier-display--1/2/3 or text-2xl.',
  ],
  ['text-h1', 'Retired. Use PageHeader (atelier-display--3).'],
  ['text-h2', 'Retired. Use font-display text-panel.'],
  ['text-h3', 'Retired. Use text-sm font-semibold.'],
  ['text-body', 'Retired. Use text-sm / text-base.'],
  ['text-caption', 'Retired. Use text-xs.'],
]);

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow named Tailwind utilities that sit outside the TagNest radius / elevation / type ladders',
    },
    schema: [],
    messages: {
      offscale: 'Off-scale utility "{{cls}}": {{fix}}',
    },
  },
  create(context) {
    // Same constant scope as no-magic-tokens: the variant tables that hold most
    // of the radius/shadow debt (`Button.SIZE`, `IconButton.SIZE`, …) are
    // module-level constants consumed through `cx()`.
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const scope = createConstScope(sourceCode);

    return {
      JSXAttribute(node) {
        if (!node.name || node.name.name !== 'className') return;
        const fragments = classFragments(node.value, scope);
        if (fragments.length === 0) return;

        const reportNode = node.value ?? node;
        for (const token of allTokens(fragments)) {
          const base = stripVariants(token);
          const fix = BANNED.get(base);
          if (fix) {
            context.report({
              node: reportNode,
              messageId: 'offscale',
              data: { cls: token, fix },
            });
          }
        }
      },
    };
  },
};
