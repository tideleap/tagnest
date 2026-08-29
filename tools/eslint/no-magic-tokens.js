/**
 * tagnest/no-magic-tokens
 *
 * Stage-1 guard for the UI Design System v2 (see ui-design-system.md).
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
 * Severity is `warn` for now; tighten to `error` once the backlog of existing
 * violations (surfaced by this rule) has been cleared in later stages.
 */

const MAGIC_COLOUR = /^(bg|text|border|ring|from|to|via)-\[/;
const MAGIC_SPACING =
  /^(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space)-\[/;
const MAGIC_RADIUS = /^rounded-\[/;
const MAGIC_SHADOW = /^shadow-\[/;
const SEMI_SURFACE = /^bg-surface\//;

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
 * time, so glass usage cannot be seen here — instead callers pass the full
 * fragment and we skip SEMI_SURFACE when a sibling token provides the blur.
 */
const LEGIT_GLASS_BLUR = /backdrop-blur/;

/** Pull a className string out of a Literal or TemplateLiteral node. */
function classFragments(valueNode) {
  if (!valueNode) return [];
  if (valueNode.type === 'Literal' && typeof valueNode.value === 'string') {
    return [valueNode.value];
  }
  if (valueNode.type === 'JSXExpressionContainer') {
    const expr = valueNode.expression;
    if (expr.type === 'TemplateLiteral') {
      return expr.quasis
        .map((q) => (q.value && q.value.raw) || '')
        .filter(Boolean);
    }
    // Conditional / member expressions: not parsed deeply to avoid false positives.
    return [];
  }
  return [];
}

/** Split one className string into individual tokens. */
function tokensOf(fragment) {
  return fragment.split(/\s+/).filter(Boolean);
}

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
        'Semi-transparent surface "{{cls}}" is discouraged — cards should use solid bg-surface; reserve opacity for glass overlays only.',
    },
  },
  create(context) {
    function check(token, node, isGlass = false) {
      if (!token) return;
      if (DYNAMIC_VARIABLE.test(token)) return;
      if (
        MAGIC_COLOUR.test(token) ||
        MAGIC_SPACING.test(token) ||
        MAGIC_RADIUS.test(token) ||
        MAGIC_SHADOW.test(token)
      ) {
        context.report({ node, messageId: 'magicValue', data: { cls: token } });
      } else if (SEMI_SURFACE.test(token) && !isGlass) {
        context.report({ node, messageId: 'semiSurface', data: { cls: token } });
      }
    }

    return {
      JSXAttribute(node) {
        if (!node.name || node.name.name !== 'className') return;
        const fragments = classFragments(node.value);
        fragments.forEach((fragment) => {
          // A backdrop-blur sibling legitimises the semi-transparent surface
          // (frosted glass); suppress SEMI_SURFACE for the whole fragment.
          const isGlass = LEGIT_GLASS_BLUR.test(fragment);
          tokensOf(fragment).forEach((token) =>
            check(token, node.value, isGlass),
          );
        });
      },
    };
  },
};
