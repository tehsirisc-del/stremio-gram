/**
 * Lightweight D-pad Spatial Navigation Engine for Android TV
 * Handles arrow keys, Enter, and Back (Backspace/Escape).
 *
 * Focus Logic: Uses standard CSS :focus with box-shadow. 
 * Clipping is avoided by generous padding on scroll containers.
 */
const SpatialNav = (() => {
  let backCallback = null;
  let lastTabFocus = null;

  function isBlocked() {
    // Check if any full-screen blocking overlay is visible
    const loader = document.getElementById('initial-loader');
    const sync = document.getElementById('sync-overlay');
    const update = document.getElementById('update-overlay-popup');
    const loaderVisible = loader && window.getComputedStyle(loader).display !== 'none';
    const syncVisible = sync && window.getComputedStyle(sync).display !== 'none';
    const updateVisible = update && window.getComputedStyle(update).display !== 'none';
    return loaderVisible || syncVisible || updateVisible;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init(onBack) {
    backCallback = onBack;
    document.addEventListener('keydown', handleKey, true);

    // Global listener: when leaving an input, make it readonly again 
    // to prevent the keyboard from popping up next time it's focused via D-pad.
    document.addEventListener('blur', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
        e.target.readOnly = true;
      }
    }, true);
  }

  let lastNavTime = 0;
  const NAV_THROTTLE = 85; // ms between moves

  // ── Key Handler ───────────────────────────────────────────────────────────
  function handleKey(e) {
    if (isBlocked()) {
      e.preventDefault();
      return;
    }
    const key = e.key;
    const active = document.activeElement;
    const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');

    if (key === 'Backspace' || key === 'Escape' || key === 'GoBack') {
      if (isInput && key === 'Backspace') return;
      e.preventDefault();
      if (backCallback) backCallback();
      return;
    }

    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' ', 'Select', 'Ok', 'Center', 'dpad_center'].includes(key)) return;

    if (isInput) {
      if (key === 'ArrowLeft' || key === 'ArrowRight') return;
    }

    if (key === 'Enter' || key === ' ' || key === 'Select' || key === 'Ok' || key === 'Center' || key === 'dpad_center') {
      if (active && active !== document.body) {
        if (isInput && (key === ' ' || key === 'Enter' || key === 'Select' || key === 'Ok')) {
          if (active.readOnly) {
            e.preventDefault();
            e.stopImmediatePropagation();
            active.readOnly = false;
            active.focus();
          } else {
            active.blur();
            active.focus();
          }
          return;
        }
        e.preventDefault();
        active.click();
      }
      return;
    }

    // ── Navigation Throttle Logic ──
    const now = Date.now();
    const isArrow = key.startsWith('Arrow');
    const timeSinceLast = now - lastNavTime;

    if (isArrow) {
      if (timeSinceLast < 150) {
          document.body.classList.add('fast-nav');
          // If spamming extremely fast (<65ms), use minimal overhead mode
          if (timeSinceLast < 65) {
              document.body.classList.add('very-fast-nav');
          }
      }

      if (timeSinceLast < NAV_THROTTLE) {
          e.preventDefault();
          return; 
      }
      lastNavTime = now;

      // Clear classes after a short delay of inactivity
      clearTimeout(window._fastNavTimeout);
      window._fastNavTimeout = setTimeout(() => {
          document.body.classList.remove('fast-nav');
          document.body.classList.remove('very-fast-nav');
      }, 250);
    }

    e.preventDefault();

    // Collect all visible focusable elements
    const openModal = document.querySelector('.modal-overlay.open');
    const container = openModal || document.body;

    const focusables = Array.from(
      container.querySelectorAll(
        '[tabindex]:not([tabindex="-1"]):not([disabled]):not(.hidden):not([style*="display: none"])'
      )
    ).filter(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.opacity === '0') return false;
      return rect.width > 0 && rect.height > 0;
    });

    if (focusables.length === 0) return;

    const currentIndex = focusables.indexOf(active);
    if (currentIndex === -1) {
      focusables[0].focus();
      return;
    }

    const currentRect = active.getBoundingClientRect();
    const cx = currentRect.left + currentRect.width / 2;
    const cy = currentRect.top + currentRect.height / 2;

    let best = null;
    let bestScore = Infinity;

    const currentZone = active.closest('[data-nav-zone]')
      ? active.closest('[data-nav-zone]').getAttribute('data-nav-zone')
      : 'content';

    for (const el of focusables) {
      if (el === active) continue;

      const elZone = el.closest('[data-nav-zone]')
        ? el.closest('[data-nav-zone]').getAttribute('data-nav-zone')
        : 'content';

      const rect = el.getBoundingClientRect();
      const ex = rect.left + rect.width / 2;
      const ey = rect.top + rect.height / 2;
      const dx = ex - cx;
      const dy = ey - cy;

      // ── Horizontal (◀/▶): same zone, same row only ──────────────────────
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        if (elZone !== currentZone) continue;
        if (Math.abs(dy) > Math.max(currentRect.height * 0.6, 40)) continue;
        if (key === 'ArrowRight' && dx <= 0) continue;
        if (key === 'ArrowLeft'  && dx >= 0) continue;

        const score = Math.abs(dx) + Math.abs(dy) * 5;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      // ── Vertical (▲/▼): crosses zones, physically closest in direction ───
      else if (key === 'ArrowUp' || key === 'ArrowDown') {
        if (key === 'ArrowDown' && dy <= 0) continue;
        if (key === 'ArrowUp'   && dy >= 0) continue;

        // --- SPECIAL LOGIC FOR UPDATE NOTIF PILL ---
        if (key === 'ArrowUp' && elZone === 'notif' && currentZone === 'tabs') {
            lastTabFocus = active;
        }
        if (key === 'ArrowDown' && currentZone === 'notif' && elZone === 'tabs') {
            if (lastTabFocus && focusables.indexOf(lastTabFocus) !== -1) {
                best = lastTabFocus;
                break;
            }
        }

        if (key === 'ArrowUp' && elZone === 'tabs' && currentZone !== 'tabs' && currentZone !== 'notif') {
          if (!el.classList.contains('active')) continue;
        }

        const score = Math.abs(dy) * 100 + Math.abs(dx);
        if (score < bestScore) { bestScore = score; best = el; }
      }
    }

    if (best) {
      best.focus();
      // Use CSS smooth scroll, behavior 'auto' respects current CSS state
      best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    }
  }

  return { init };
})();
