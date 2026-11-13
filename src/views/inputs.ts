/**
 * Select a text field's whole value whenever it gains focus, by click or by
 * keyboard, so a new value can be typed or pasted straight over it. A click
 * on a field that already has focus still places the caret as usual.
 */
export function selectAllOnFocus(input: HTMLInputElement) {
  input.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || document.activeElement === input) return;
    // Focusing here, not in the browser's default, keeps the mouseup from collapsing the selection.
    e.preventDefault();
    input.focus();
  });
  input.addEventListener("focus", () => input.select());
}
