// Safe DOM construction helpers for the TagNest extension UI.
//
// These replace every dynamic `element.innerHTML = ...` assignment. Setting
// text via `textContent` lets the browser auto-escape untrusted values
// (bookmark titles and URLs can contain `<`, `&`, `"`, etc.), which removes
// both the XSS risk and the Firefox addon-linter `UNSAFE_VAR_ASSIGNMENT`
// warnings. Keep all user-supplied data flowing through `textContent` or
// `escapeHtml` — never concatenate it into an innerHTML string.

/** Remove every child node from `node`. */
export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Create an element with an optional class and text. The text (if provided)
 * is assigned via `textContent`, so it is auto-escaped.
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Escape a string for safe insertion into an HTML context (legacy helper). */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]),
  );
}
