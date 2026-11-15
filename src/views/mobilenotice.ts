/**
 * On a phone-sized screen, a full-screen notice that the app is made for desktop:
 * two 3D/2D views, precise dragging and keyboard shortcuts need room and a mouse.
 * "Continue anyway" dismisses it, remembered in this browser, so it shows once.
 */
const KEY = "gp.mobileNoticeDismissed";
/** The app's own phone layout starts here (see the 760px media query in style.css). */
const PHONE = "(max-width: 760px)";

export function showMobileNotice() {
  if (!matchMedia(PHONE).matches) return;
  try { if (localStorage.getItem(KEY) === "1") return; } catch { /* storage blocked: show it */ }

  const root = document.createElement("div");
  root.className = "mobile-notice";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "mobile-notice-title");
  root.innerHTML = `
    <div class="mn-card">
      <svg class="mn-icon" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
      <h2 id="mobile-notice-title">Best on a bigger screen</h2>
      <p>Gradient Paths is built for desktop: it shows a 3D view and a 2D slice side by side, and shaping a path takes precise dragging. On a phone it works, but it is cramped.</p>
      <button type="button" class="primary-btn mn-continue">Continue anyway</button>
    </div>`;
  document.body.append(root);
  document.documentElement.classList.add("mobile-notice-open");

  const btn = root.querySelector<HTMLButtonElement>(".mn-continue")!;
  btn.onclick = () => {
    try { localStorage.setItem(KEY, "1"); } catch { /* storage blocked */ }
    root.remove();
    document.documentElement.classList.remove("mobile-notice-open");
  };
  // Focused for keyboards and screen readers, without drawing the keyboard ring on open.
  btn.focus({ focusVisible: false } as FocusOptions);
}
