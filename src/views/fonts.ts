/**
 * Font stack for text drawn on canvases (chart ticks, slice captions, 3D labels),
 * matching the page's base font. Canvas text drawn before the web font loads
 * falls back to the system font; see `whenCanvasFontReady`.
 */
export const CANVAS_SANS = `"Geist Variable", ui-sans-serif, system-ui, sans-serif`;

/** Resolves once the canvas font can be drawn: canvases do not trigger a web font's download themselves. */
export function whenCanvasFontReady(): Promise<unknown> {
  if (!document.fonts?.load) return Promise.resolve();
  return document.fonts.load(`600 12px ${CANVAS_SANS}`).catch(() => {});
}
