/**
 * Shared `className` extraction helpers for the `tagnest/*` ESLint rules.
 *
 * Extracted in T01 so that `no-magic-tokens`, `no-offscale-tokens` and
 * `require-focus-ring` all see exactly the same set of class strings. Before
 * this module existed, each rule would have had to duplicate the traversal —
 * and a fix in one copy would silently not apply to the others. That is
 * precisely how audit finding G-01 (the rule being 100% blind to `cx()`)
 * survived: there was one copy, it was wrong, and nothing tested it.
 *
 * Coverage (fixes G-01):
 *   - `Literal`                 className="a b"
 *   - `TemplateLiteral`         className={`a b ${dyn}`}   (static quasis only)
 *   - `CallExpression`          className={cx('a', 'b')}   (any callee: cx/clsx/twMerge/cn)
 *   - `ConditionalExpression`   className={ok ? 'a' : 'b'} (both branches)
 *   - `LogicalExpression`       className={ok && 'a'}      (both operands)
 *   - `ArrayExpression`         className={['a', 'b']}
 *   - `Identifier`              className={CONTROL_BASE}   (string const or cx() result,
 *                               resolved through ESLint's scope chain — module level
 *                               AND function-body locals)
 *   - `MemberExpression`        className={VARIANT[variant]} (literal lookup table,
 *                               all values treated as candidates — see `resolveClassTable`)
 *
 * Deliberately NOT covered (would require type information or runtime values):
 *   - `SpreadElement` inside a call/array
 *   - `${}` interpolations inside a template literal
 *   - identifiers whose binding has no statically-foldable initializer (function
 *     parameters, props, hook results) — these resolve to `[]`, not to a guess,
 *     so they never produce a false positive.
 */

/** Maximum AST depth walked by {@link exprFragments}. Guards against pathological nesting. */
const MAX_DEPTH = 16;

/**
 * Split one className string into individual tokens.
 *
 * @param {string} fragment Raw class string (may contain newlines from `+` concatenation).
 * @return {string[]} Non-empty whitespace-separated tokens.
 */
export function tokensOf(fragment) {
  if (typeof fragment !== 'string' || fragment.length === 0) return [];
  return fragment.split(/\s+/).filter(Boolean);
}

/**
 * Index of the last `:` that can be a Tailwind variant separator, or -1.
 *
 * Colons inside an arbitrary value (`bg-[url(data:image/png)]`) or inside an
 * arbitrary variant (`data-[state=open]:bg-surface/85`) are not variant
 * separators, so the scan tracks bracket depth and only accepts colons at
 * depth 0.
 *
 * @param {string} token A single class token.
 * @return {number} Index of the separating colon, or -1 when there is none.
 */
function lastVariantColon(token) {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ':' && depth === 0) last = i;
  }
  return last;
}

/**
 * Strip Tailwind variant prefixes from a token, returning the base utility.
 *
 * `md:hover:rounded` -> `rounded`; `focus-visible:outline-none` -> `outline-none`.
 * Rules that care about *which* utility is used (rather than which state it
 * applies to) must compare on the base, otherwise `hover:rounded` slips past a
 * check written for `rounded`.
 *
 * Arbitrary values may themselves contain `:` (e.g. `bg-[url(data:image/png)]`,
 * `bg-[right_0.6rem_center]`), so the search for the last variant separator is
 * bounded by the first `[`: only colons that appear *before* any arbitrary
 * value can be variant separators.
 *
 * @param {string} token A single class token.
 * @return {string} The base utility without variant prefixes.
 */
export function stripVariants(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  const idx = lastVariantColon(token);
  return idx === -1 ? token : token.slice(idx + 1);
}

/**
 * The variant prefix chain of a token, as a lowercase string ending in `:`.
 *
 * `md:hover:rounded` -> `md:hover:`; `rounded` -> `''`.
 *
 * @param {string} token A single class token.
 * @return {string} Prefix chain (possibly empty).
 */
export function variantsOf(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  const idx = lastVariantColon(token);
  return idx === -1 ? '' : token.slice(0, idx + 1);
}

/**
 * Statically fold an initializer expression into a single class string.
 *
 * Handles the shapes actually used by TagNest's variant tables:
 *   - `const X = 'a b'`
 *   - `` const X = `a b` ``            (static quasis joined)
 *   - `const X = 'a' + 'b'`            (Field.tsx:57-62 CONTROL_BASE)
 *   - `const X = { sm: 'a', md: 'b' }` (Button.tsx:14-32 VARIANT / SIZE)
 *   - `const X = { ... } as const`     (Field.tsx:81-85 INPUT_SIZE — TSAsExpression)
 *   - `const X = cond ? 'a' : 'b'` / `const X = cond && 'a'`
 *
 * Object values are joined with a single space so that a lookup-table access
 * (`VARIANT[variant]`) can be checked against *every* legal appearance at once.
 *
 * @param {object|null|undefined} node An ESTree expression node.
 * @return {string|null} The folded string, or `null` when it cannot be determined.
 */
export function joinStringValues(node) {
  if (!node || typeof node !== 'object') return null;

  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? node.value : null;

    case 'TemplateLiteral':
      return node.quasis
        .map((q) => (q.value && q.value.raw) || '')
        .filter(Boolean)
        .join(' ');

    case 'ObjectExpression': {
      const parts = [];
      for (const prop of node.properties) {
        // SpreadElement has no `value`; skip it rather than guessing.
        if (!prop || prop.type !== 'Property') continue;
        const folded = joinStringValues(prop.value);
        if (folded) parts.push(folded);
      }
      return parts.length > 0 ? parts.join(' ') : null;
    }

    case 'ArrayExpression': {
      const parts = [];
      for (const el of node.elements) {
        const folded = joinStringValues(el);
        if (folded) parts.push(folded);
      }
      return parts.length > 0 ? parts.join(' ') : null;
    }

    case 'BinaryExpression':
      if (node.operator !== '+') return null;
      return [joinStringValues(node.left), joinStringValues(node.right)]
        .filter(Boolean)
        .join(' ') || null;

    case 'ConditionalExpression':
      return (
        [joinStringValues(node.consequent), joinStringValues(node.alternate)]
          .filter(Boolean)
          .join(' ') || null
      );

    case 'LogicalExpression':
      return (
        [joinStringValues(node.left), joinStringValues(node.right)]
          .filter(Boolean)
          .join(' ') || null
      );

    // TypeScript wrappers: `const X = {...} as const` / `satisfies T`.
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSTypeAssertion':
      return joinStringValues(node.expression);

    case 'ParenthesizedExpression':
      return joinStringValues(node.expression);

    default:
      return null;
  }
}

/**
 * Build the constant scope used to resolve `Identifier` and `MemberExpression`
 * class references.
 *
 * Resolution is two-tier:
 *
 * 1. **ESLint's scope manager** (preferred). Given the reference *node*, it
 *    walks the scope chain outward and returns the fragments of the binding
 *    that is actually in scope. This is exact — it handles shadowing, and it
 *    reaches function-body locals such as `const base = cx('border-brand/25', …)`
 *    inside a `.map()` callback (OrganizePage.tsx:381-386), which a
 *    module-level-only collector cannot see.
 * 2. **Module-level table** (fallback). Used when the scope manager is
 *    unavailable, or when the binding has no statically-known initializer.
 *    Covers the design-system variant tables (`VARIANT`, `SIZE`,
 *    `CONTROL_BASE`, …) that are module-level by convention.
 *
 * A binding whose initializer is not statically foldable (a function
 * parameter, a prop, a hook result) resolves to `[]` — never to a guess.
 *
 * @param {object} sourceCode The ESLint `SourceCode` object for the file.
 * @return {{resolveIdentifier: (node: object, seen?: Set<object>) => string[],
 *           resolveClassTable: (node: object, seen?: Set<object>) => string[]}}
 */
export function createConstScope(sourceCode) {
  /** @type {Map<string, {text: string, isTable: boolean}>} */
  const moduleConsts = new Map();

  /**
   * @param {object|null|undefined} node A statement node (possibly null).
   * @return {void}
   */
  function collectConst(node) {
    if (!node || node.type !== 'VariableDeclaration') return;
    for (const decl of node.declarations) {
      if (!decl || !decl.id || decl.id.type !== 'Identifier' || !decl.init) continue;
      const text = joinStringValues(decl.init);
      if (!text) continue;
      moduleConsts.set(decl.id.name, {
        text,
        isTable: isObjectLike(decl.init),
      });
    }
  }

  /**
   * @param {object|null|undefined} node An initializer expression node.
   * @return {boolean} True when the node is an object literal, possibly wrapped
   *   in `{…} as const` / `{…} satisfies T`.
   */
  function isObjectLike(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'ObjectExpression') return true;
    if (
      node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSTypeAssertion' ||
      node.type === 'ParenthesizedExpression'
    ) {
      return isObjectLike(node.expression);
    }
    return false;
  }

  const ast = sourceCode && sourceCode.ast;
  const body = (ast && ast.body) || [];
  for (const stmt of body) {
    if (!stmt) continue;
    if (stmt.type === 'ExportNamedDeclaration') {
      collectConst(stmt.declaration);
    } else {
      collectConst(stmt);
    }
  }

  /**
   * Find the initializer node of the binding in scope for a reference.
   *
   * @param {object} node The `Identifier` reference node.
   * @return {object|null} The initializer expression, or null when the binding
   *   is not found or has no initializer (e.g. a function parameter).
   */
  function findInitInScope(node) {
    if (typeof sourceCode.getScope !== 'function') return null;
    let current = sourceCode.getScope(node);
    while (current) {
      const variable = current.set && current.set.get(node.name);
      if (variable) {
        for (const def of variable.defs || []) {
          // `def.type === 'Variable'` => a VariableDeclarator; `def.node` is the
          // declarator, whose `init` is the initializer (null for `let x;`).
          if (def.type === 'Variable' && def.node && def.node.init) {
            return def.node.init;
          }
        }
        // Binding found but not statically initialisable (parameter, import,
        // `let x;`). Stop here rather than falling through to a module-level
        // constant of the same name, which would be a different variable.
        return null;
      }
      current = current.upper;
    }
    return null;
  }

  const self = {
    /**
     * Resolve an `Identifier` reference to its class fragments.
     *
     * @param {object} node The `Identifier` node.
     * @param {Set<object>} [seen] Cycle guard over already-expanded initializers.
     * @return {string[]} Class-string fragments (possibly empty).
     */
    resolveIdentifier(node, seen = new Set()) {
      if (!node || typeof node.name !== 'string') return [];

      const init = findInitInScope(node);
      if (init) {
        if (seen.has(init)) return [];
        seen.add(init);
        return exprFragments(init, self, 0, seen);
      }

      const hit = moduleConsts.get(node.name);
      return hit ? [hit.text] : [];
    },

    /**
     * Resolve a `MemberExpression`'s object to its class fragments, but only
     * when that object is a literal lookup table.
     *
     * `VARIANT[variant]` has a runtime key, so the conservative-but-useful
     * answer is "every value in the table is a candidate". Anything that is not
     * an object literal (`props.foo`, `arr[i]`) resolves to nothing.
     *
     * @param {object} node The `MemberExpression` node.
     * @param {Set<object>} [seen] Cycle guard over already-expanded initializers.
     * @return {string[]} Class-string fragments (possibly empty).
     */
    resolveClassTable(node, seen = new Set()) {
      const obj = node && node.object;
      if (!obj || obj.type !== 'Identifier') return [];

      const init = findInitInScope(obj);
      if (init) {
        if (!isObjectLike(init)) return [];
        if (seen.has(init)) return [];
        seen.add(init);
        return exprFragments(init, self, 0, seen);
      }

      const hit = moduleConsts.get(obj.name);
      return hit && hit.isTable ? [hit.text] : [];
    },
  };

  return self;
}

/**
 * Recursively extract every statically-known class string from an expression.
 *
 * @param {object|null|undefined} expr An ESTree expression node.
 * @param {{resolveIdentifier: (node: object, seen?: Set<object>) => string[],
 *          resolveClassTable: (node: object, seen?: Set<object>) => string[]}} scope
 * @param {number} [depth] Internal recursion guard.
 * @param {Set<object>} [seen] Cycle guard over already-expanded initializers.
 * @return {string[]} Class-string fragments (may be empty; never null).
 */
export function exprFragments(expr, scope, depth = 0, seen = new Set()) {
  if (!expr || typeof expr !== 'object') return [];
  if (depth > MAX_DEPTH) return [];

  switch (expr.type) {
    case 'Literal':
      return typeof expr.value === 'string' ? [expr.value] : [];

    case 'TemplateLiteral':
      // Only the static quasis are analysable; `${}` interpolations are skipped.
      return expr.quasis.map((q) => (q.value && q.value.raw) || '').filter(Boolean);

    case 'CallExpression':
      // cx('a', cond && 'b', ok ? 'c' : 'd', ...rest) — SpreadElement yields [].
      return expr.arguments.flatMap((arg) => exprFragments(arg, scope, depth + 1, seen));

    case 'ConditionalExpression':
      return [
        ...exprFragments(expr.consequent, scope, depth + 1, seen),
        ...exprFragments(expr.alternate, scope, depth + 1, seen),
      ];

    case 'LogicalExpression':
      return [
        ...exprFragments(expr.left, scope, depth + 1, seen),
        ...exprFragments(expr.right, scope, depth + 1, seen),
      ];

    case 'ArrayExpression':
      return expr.elements.flatMap((el) => exprFragments(el, scope, depth + 1, seen));

    case 'ObjectExpression':
      // A variant lookup table (`const VARIANT = { primary: '…', ghost: '…' }`).
      // Each value is emitted as its OWN fragment so that per-fragment semantics
      // (notably the frosted-glass exemption) stay scoped to one appearance
      // instead of bleeding across unrelated variants.
      return expr.properties.flatMap((prop) =>
        prop && prop.type === 'Property'
          ? exprFragments(prop.value, scope, depth + 1, seen)
          : [],
      );

    case 'BinaryExpression':
      // `'a b' + 'c d'` — the shape of Field.tsx:57-62 CONTROL_BASE. The parts
      // form one continuous class string, so fold them into a single fragment.
      if (expr.operator !== '+') return [];
      return toFragment(joinStringValues(expr));

    case 'Identifier':
      // A string constant or a `cx(...)` result in scope — module level or a
      // function-body local (e.g. Field.tsx:57 CONTROL_BASE, OrganizePage:381).
      return scope && typeof scope.resolveIdentifier === 'function'
        ? scope.resolveIdentifier(expr, seen)
        : [];

    case 'MemberExpression':
      // VARIANT[variant] / SIZE[size] — see `resolveClassTable`.
      return scope && typeof scope.resolveClassTable === 'function'
        ? scope.resolveClassTable(expr, seen)
        : [];

    // TypeScript wrappers around a class expression.
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSTypeAssertion':
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      return exprFragments(expr.expression, scope, depth + 1, seen);

    default:
      return [];
  }
}

/**
 * Normalise a nullable string into a fragment array.
 *
 * @param {string|null|undefined} value Resolved class string.
 * @return {string[]} `[value]` when non-empty, otherwise `[]`.
 */
function toFragment(value) {
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

/**
 * Extract every statically-known class string from a `className` JSX attribute
 * value node.
 *
 * @param {object|null|undefined} valueNode The `JSXAttribute.value` node
 *   (a `Literal`, or a `JSXExpressionContainer`, or null for `className`).
 * @param {{resolveIdentifier: (node: object, seen?: Set<object>) => string[],
 *          resolveClassTable: (node: object, seen?: Set<object>) => string[]}} scope
 * @return {string[]} Class-string fragments (may be empty; never null).
 */
export function classFragments(valueNode, scope) {
  if (!valueNode) return [];
  if (valueNode.type === 'JSXExpressionContainer') {
    return exprFragments(valueNode.expression, scope);
  }
  return exprFragments(valueNode, scope);
}

/**
 * Join fragments into one string so cross-fragment relationships (e.g. a
 * `backdrop-blur` sibling legitimising a semi-transparent surface) can be
 * evaluated once for the whole attribute instead of per fragment.
 *
 * @param {string[]} fragments Class-string fragments.
 * @return {string} Space-joined class string.
 */
export function joinFragments(fragments) {
  return Array.isArray(fragments) ? fragments.join(' ') : '';
}

/**
 * Every token of every fragment, flattened.
 *
 * @param {string[]} fragments Class-string fragments.
 * @return {string[]} All tokens in source order.
 */
export function allTokens(fragments) {
  if (!Array.isArray(fragments)) return [];
  return fragments.flatMap((fragment) => tokensOf(fragment));
}
