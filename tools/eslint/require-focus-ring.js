/**
 * tagnest/require-focus-ring
 *
 * Keyboard-focus guard for the UI Design System v2 (audit findings A-01 / A-02).
 *
 * Two independent checks, deliberately asymmetric in strictness:
 *
 * 1. `outlineNoneWithoutIndicator` — the **hard** rule. An element that removes
 *    the browser outline (`outline-none` / `outline-hidden`, with or without a
 *    `focus:` / `focus-visible:` variant) must put *something* back in the same
 *    `className`: one of the L2 focus-ring utilities (`focus-ring`,
 *    `focus-ring-round`, `focus-ring-inset`) or a `focus:` / `focus-visible:`
 *    token that actually paints an indicator. Without that, the element also
 *    loses the global fallback in `index.css:30-34` and becomes invisible to
 *    keyboard users. This check is element-agnostic and has essentially no
 *    false-positive surface, because everything it needs is inside one
 *    `className`.
 *
 * 2. `missingFocusRing` — the **advisory** rule (`warn`, exemptable per site
 *    with `eslint-disable-next-line`). Every natively focusable element
 *    (`<button>`, `<input>` except `type="hidden"`, `<select>`, `<textarea>`,
 *    `<a href>`) and every element carrying an interactive ARIA role
 *    (`button` / `tab` / `menuitem` / `switch` / `checkbox` / `radio`) should
 *    declare a focus indicator.
 *
 * Scope limits (intentional — see the T01 risk register):
 *   - Check 2 only fires for **lower-case intrinsic** elements. A `<Button>`
 *     call site inherits its ring from the primitive; flagging every call site
 *     would be noise and would not go away once the primitive is fixed.
 *   - The rule does **not** try to determine whether an element sits under a
 *     CSS class that already provides `:focus-visible` (`.nav-row`,
 *     `.chrome-btn`, `.cat-chip`, `.atelier-search`). That is not decidable
 *     from a single file's AST, and guessing produces false positives that
 *     block later batches. Such sites are exempted individually with
 *     `eslint-disable-next-line tagnest/require-focus-ring`.
 *   - Elements taken out of the tab order (`tabIndex={-1}`) are skipped by both
 *     checks: they can only be focused programmatically, and the two such
 *     elements in the app — the skip-link destination `<main id="main">`
 *     (AppLayout.tsx:92-95) and the modal panel `role="dialog"`
 *     (Modal.tsx:145-154) — carry `outline-none` deliberately, because a ring
 *     around the whole page/panel would be noise. Neither is listed as an A-01
 *     or A-02 finding. Statically `disabled` elements are skipped by check 2.
 *   - A `className` that resolves to zero statically-known fragments (a bare
 *     forwarded prop such as `className={classes}`) is skipped by check 2 —
 *     the tokens are unknowable, and reporting would be a guess.
 *   - When check 1 fires, check 2 is suppressed for the same element: both
 *     would describe one root cause, and the hard rule's message is the more
 *     actionable of the two.
 */

import {
  allTokens,
  classFragments,
  createConstScope,
  stripVariants,
  variantsOf,
} from './_class-fragments.js';

/** Intrinsic elements that are focusable by default in a browser. */
const FOCUSABLE_TAGS = new Set(['button', 'input', 'select', 'textarea']);

/** ARIA roles that make an otherwise inert element keyboard-focusable. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'tab',
  'menuitem',
  'switch',
  'checkbox',
  'radio',
]);

/** Tailwind utilities that suppress the outline (v3 `outline-none`, v4 `outline-hidden`). */
const OUTLINE_SUPPRESSORS = new Set(['outline-none', 'outline-hidden']);

/**
 * Base utilities that visibly mark focus. Used both to decide whether an
 * outline suppressor is compensated and whether an interactive element
 * declares any indicator at all.
 */
const INDICATOR_BASE = /^(ring|outline|border|bg|shadow|decoration|accent)-/;

/** The L2 focus-ring utility family shipped by `index.css` (T02). */
const FOCUS_RING_CLASS = /^focus-ring(-round|-inset)?$/;

/**
 * Read a JSX attribute's static string / boolean / number value.
 *
 * @param {object|null|undefined} attr A `JSXAttribute` node.
 * @return {string|boolean|number|null} The literal value, or null when dynamic.
 */
function literalValueOf(attr) {
  if (!attr || !attr.value) return null;
  if (attr.value.type === 'Literal') {
    return typeof attr.value.value === 'string' ||
      typeof attr.value.value === 'boolean' ||
      typeof attr.value.value === 'number'
      ? attr.value.value
      : null;
  }
  if (attr.value.type === 'JSXExpressionContainer') {
    const expr = attr.value.expression;
    if (!expr) return null;
    if (expr.type === 'Literal') {
      return typeof expr.value === 'string' ||
        typeof expr.value === 'boolean' ||
        typeof expr.value === 'number'
        ? expr.value
        : null;
    }
    // tabIndex={-1} parses as UnaryExpression('-', Literal(1)).
    if (
      expr.type === 'UnaryExpression' &&
      expr.operator === '-' &&
      expr.argument &&
      expr.argument.type === 'Literal' &&
      typeof expr.argument.value === 'number'
    ) {
      return -expr.argument.value;
    }
  }
  return null;
}

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require a visible keyboard-focus indicator on interactive elements, and forbid removing the outline without replacing it',
    },
    schema: [],
    messages: {
      outlineNoneWithoutIndicator:
        '"{{cls}}" removes the focus outline but this className provides no replacement indicator. Add focus-ring (or a focus-visible:ring-*/outline-* utility) so keyboard users can see where focus is — see index.css:30-34 and audit A-01.',
      missingFocusRing:
        '<{{tag}}> is keyboard-focusable but declares no focus indicator. Add focus-ring / focus-ring-round / focus-ring-inset, or a focus-visible:ring-* utility. If the ring comes from a CSS class (e.g. .nav-row, .chrome-btn, .cat-chip), exempt this line with eslint-disable-next-line tagnest/require-focus-ring.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const scope = createConstScope(sourceCode);

    /**
     * Classify one element's class tokens.
     *
     * @param {string[]} tokens All tokens of the element's `className`.
     * @return {{suppressor: string|null, hasIndicator: boolean}} `suppressor` is
     *   the first outline-suppressing token found (or null); `hasIndicator` is
     *   true when some token paints a focus indicator.
     */
    function classify(tokens) {
      let suppressor = null;
      let hasIndicator = false;

      for (const token of tokens) {
        const base = stripVariants(token);
        const variants = variantsOf(token);

        if (OUTLINE_SUPPRESSORS.has(base)) {
          if (suppressor === null) suppressor = token;
          continue;
        }
        if (FOCUS_RING_CLASS.test(base)) {
          hasIndicator = true;
          continue;
        }
        // `focus:ring-2` / `focus-visible:outline-brand` — a state-scoped
        // indicator. `focus:` (not only `focus-visible:`) counts here: the
        // element *does* show something, its contrast/trigger correctness is
        // policed by no-magic-tokens and scripts/check-contrast.mjs instead.
        const isFocusState = variants === 'focus:' || variants === 'focus-visible:';
        if (isFocusState && INDICATOR_BASE.test(base)) {
          hasIndicator = true;
        }
      }

      return { suppressor, hasIndicator };
    }

    /**
     * The intrinsic tag name of a JSX opening element, or null for components.
     *
     * @param {object} opening A `JSXOpeningElement` node.
     * @return {string|null} Lower-case tag name, or null when not intrinsic.
     */
    function intrinsicTag(opening) {
      const name = opening.name;
      if (!name || name.type !== 'JSXIdentifier') return null;
      const raw = name.name;
      // Upper-case first letter => a React component, not a DOM element.
      if (typeof raw !== 'string' || raw.length === 0) return null;
      return raw[0] === raw[0].toLowerCase() ? raw : null;
    }

    return {
      JSXOpeningElement(node) {
        const attrs = Array.isArray(node.attributes) ? node.attributes : [];

        const attrByName = new Map();
        for (const a of attrs) {
          if (a && a.type === 'JSXAttribute' && a.name && typeof a.name.name === 'string') {
            attrByName.set(a.name.name, a);
          }
        }
        const classAttr = attrByName.get('className');

        // Elements taken out of the tab order cannot be reached by keyboard, so
        // neither check applies. This is the deliberate shape of the two
        // programmatic-focus targets in the app: the skip-link destination
        // (`<main id="main" tabIndex={-1} className="… outline-none">`,
        // AppLayout.tsx:92-95) and the modal panel (`role="dialog"
        // tabIndex={-1} … outline-none`, Modal.tsx:145-154). Both are focused by
        // script, never by Tab, and a ring on them would be visual noise.
        if (literalValueOf(attrByName.get('tabIndex')) === -1) return;

        const fragments = classAttr ? classFragments(classAttr.value, scope) : [];
        const tokens = allTokens(fragments);
        const { suppressor, hasIndicator } = classify(tokens);

        // ---- Check 1 (hard): outline removed with nothing put back --------
        if (suppressor !== null && !hasIndicator) {
          context.report({
            node: classAttr.value ?? classAttr,
            messageId: 'outlineNoneWithoutIndicator',
            data: { cls: suppressor },
          });
          // Check 2 would report the same root cause with a less specific
          // message; the hard rule already says exactly what to add.
          return;
        }

        // ---- Check 2 (advisory): focusable element without an indicator ---
        const tag = intrinsicTag(node);
        if (tag === null) return;

        const role = literalValueOf(attrByName.get('role'));
        const isInteractiveRole = typeof role === 'string' && INTERACTIVE_ROLES.has(role);

        let focusable = false;
        if (FOCUSABLE_TAGS.has(tag)) {
          focusable = true;
          // `<input type="hidden">` is not rendered and never focusable.
          if (tag === 'input' && literalValueOf(attrByName.get('type')) === 'hidden') {
            focusable = false;
          }
        } else if (tag === 'a') {
          // `<a>` is only focusable when it has an href.
          focusable = attrByName.has('href');
        }
        if (isInteractiveRole) focusable = true;

        if (!focusable) return;

        // Statically disabled elements cannot receive keyboard focus.
        const disabledAttr = attrByName.get('disabled');
        if (disabledAttr) {
          // Bare `disabled` (value === null) is statically true; `disabled={true}`
          // likewise. `disabled={expr}` is dynamic and is NOT skipped.
          const disabledValue = literalValueOf(disabledAttr);
          if (disabledAttr.value === null || disabledValue === true) return;
        }

        // A className we cannot see at all (bare forwarded prop) is not judged.
        if (classAttr && fragments.length === 0) return;

        if (!hasIndicator) {
          context.report({
            node: classAttr ? (classAttr.value ?? classAttr) : node.name,
            messageId: 'missingFocusRing',
            data: {
              tag: isInteractiveRole && !FOCUSABLE_TAGS.has(tag) ? `${tag} role="${role}"` : tag,
            },
          });
        }
      },
    };
  },
};
