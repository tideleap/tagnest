/**
 * tagnest/no-magic-tokens
 *
 * Stage-1 guard for the UI Design System v2 (see docs/ui-design-system-audit.md).
 *
 * The design system mandates that every colour, spacing, radius and shadow
 * value comes from `theme.css` tokens — never from an arbitrary Tailwind
 * value like `bg-[#fff]` or `p-[13px]`. This rule warns (does not error, so
 * it cannot break the green build gate yet) whenever a `className` bypasses
 * the token system.
 *
 * It is intentionally scoped to the *visual-foundation* categories the spec
 * calls out (colour / spacing / radius / shadow) and excludes layout/position
 * arbitrary values (w-[], h-[], max-w-[], grid-cols-[], inset[], z-[]) which
 * are routinely necessary and not part of the token contract.
 *
 * Severity is `warn` for now; tighten to `error` in T15 once the backlog of
 * existing violations (surfaced by this rule) has been cleared.
 *
 * T01 fixes applied here:
 *   - G-01: class traversal moved to `_class-fragments.js`, which understands
 *     `cx(...)` / conditionals / logical expressions / module-level constants.
 *     The previous local `classFragments()` returned `[]` for every
 *     `CallExpression`, so all 10 `ui/` primitives (whose variant tables are
 *     100% `cx()`-driven) were invisible and the rule emitted 0 messages.
 *   - G-01 (derived): the frosted-glass exemption is now evaluated once over
 *     the whole `className` attribute instead of per fragment, because
 *     `cx('bg-surface/85', 'backdrop-blur-sm')` splits the pair across two
 *     fragments and the per-fragment test could not see the blur sibling.
 *   - G-02: `SEMI_SURFACE` (only `bg-surface/`) widened to `SEMI_TRANSPARENT`
 *     (all 22 observed families) plus a `SEMI_ALLOWLIST` for gradient stops.
 */

import {
  allTokens,
  classFragments,
  createConstScope,
  joinFragments,
  stripVariants,
} from './_class-fragments.js';

const MAGIC_COLOUR = /^(bg|text|border|ring|from|to|via)-\[/;
const MAGIC_SPACING =
  /^(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space)-\[/;
const MAGIC_RADIUS = /^rounded-\[/;
const MAGIC_SHADOW = /^shadow-\[/;

/**
 * Colour utilities resolved from CSS custom properties at runtime
 * (e.g. `bg-[var(--tag-dot)]` from tagColorVars) are part of the dynamic
 * theming contract, not magic values. The bracket value sits after the
 * utility prefix (bg-/text-/ring-…), so we test for `var(`/`--` right
 * after the opening bracket rather than at the start of the token.
 */
const DYNAMIC_VARIABLE = /-\[(var\(|--)/;

/**
 * Legitimate frosted-glass overlays pair a semi-transparent surface with
 * `backdrop-blur` on the same element. The rule evaluates one token at a
 * time, so glass usage cannot be seen from a single token — instead the whole
 * attribute is joined and tested once (see the `JSXAttribute` visitor).
 */
const LEGIT_GLASS_BLUR = /backdrop-blur/;

/**
 * Semi-transparent token. Fixes G-02: the previous `/^bg-surface\//` covered
 * only `bg-surface/NN`, while the 112 measured semi-transparent tokens are
 * spread over 22 families (`bg-brand-soft/`, `bg-sunken/`, `border-line/`,
 * `ring-brand/`, `text-white/`, …) — the other 21 were entirely blind spots.
 *
 * Now covers any "semantic colour token + /opacity" combination. Legitimate
 * glass (paired with `backdrop-blur`) and the new opaque glass tokens
 * (`bg-glass-raised` / `bg-glass-solid`, no slash) fall outside the match
 * naturally.
 *
 * Tested against the token with variant prefixes stripped, so `hover:bg-brand/20`
 * and `focus-visible:ring-brand/30` are seen too (13 of the 112 are prefixed).
 */
const SEMI_TRANSPARENT =
  /^(bg|text|border|ring|divide|from|to|via|shadow|fill|stroke|outline|decoration)-[a-z0-9-]+\/[0-9]{1,3}$/;

/**
 * Allowlist: semi-transparent usages the design system explicitly permits.
 *  - `bg-scrim` / `bg-scrim-soft` / `bg-scrim-strong`: scrims (§1.1) are opaque
 *    tokens without a slash, so they never match SEMI_TRANSPARENT and need no
 *    entry here.
 *  - Gradient stops (`from-` / `via-` / `to-`) legitimately need raw opacity in
 *    decorative backgrounds.
 */
const SEMI_ALLOWLIST = /^(from|via|to)-/;

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow arbitrary Tailwind magic values that bypass design tokens',
    },
    schema: [],
    messages: {
      magicValue:
        'Arbitrary value "{{cls}}" bypasses the design token system. Use a token-based utility (e.g. p-4, rounded-lg, bg-surface).',
      semiSurface:
        'Semi-transparent colour "{{cls}}" is discouraged. Use an opaque semantic token instead: bg-glass-raised / bg-glass-solid / bg-sunken-wash / bg-brand-wash / border-line-soft / bg-scrim. Reserve raw opacity for gradient stops (from-/via-/to-) and legitimate frosted glass (paired with backdrop-blur).',
    },
  },
  create(context) {
    // Module-level string constants (`const CONTROL_BASE = '…'`,
    // `const VARIANT = { primary: '…' }`) are resolved before any JSXAttribute
    // is visited, because the visitor fires in source order and the tables are
    // usually declared above the component that consumes them — but not always.
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const scope = createConstScope(sourceCode);

    /**
     * Report one token when it bypasses the token system.
     *
     * Variant prefixes are stripped before matching (so `hover:bg-[#fff]` is
     * caught by the same patterns as `bg-[#fff]`) but the **original** token is
     * reported, so the message points at exactly what to edit.
     *
     * @param {string} token A single class token.
     * @param {object} node The AST node to attach the report to.
     * @param {boolean} [isGlass] True when a `backdrop-blur` sibling legitimises
     *   the semi-transparent surface (frosted glass).
     * @return {void}
     */
    function check(token, node, isGlass = false) {
      if (!token) return;
      const base = stripVariants(token);
      if (!base) return;
      if (DYNAMIC_VARIABLE.test(base)) return;
      if (
        MAGIC_COLOUR.test(base) ||
        MAGIC_SPACING.test(base) ||
        MAGIC_RADIUS.test(base) ||
        MAGIC_SHADOW.test(base)
      ) {
        context.report({ node, messageId: 'magicValue', data: { cls: token } });
      } else if (
        SEMI_TRANSPARENT.test(base) &&
        !SEMI_ALLOWLIST.test(base) &&
        !isGlass
      ) {
        context.report({ node, messageId: 'semiSurface', data: { cls: token } });
      }
    }

    return {
      JSXAttribute(node) {
        if (!node.name || node.name.name !== 'className') return;
        const fragments = classFragments(node.value, scope);
        if (fragments.length === 0) return;

        // A backdrop-blur sibling legitimises the semi-transparent surface
        // (frosted glass). Judged over the joined attribute, not per fragment.
        const isGlass = LEGIT_GLASS_BLUR.test(joinFragments(fragments));
        const reportNode = node.value ?? node;

        for (const token of allTokens(fragments)) {
          check(token, reportNode, isGlass);
        }
      },
    };
  },
};
