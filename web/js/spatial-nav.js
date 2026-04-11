/**
 * Lightweight D-pad Spatial Navigation Engine for Android TV
 * Sidebar Layout: Tab-bar is VERTICAL on the LEFT side.
 * - ArrowLeft moves within content, switches to sidebar ONLY at leftmost edge.
 * - ArrowRight moves within sidebar, switches to content at rightmost edge.
 */
const SpatialNav = (() => {
  let backCallback = null;
  let lastTabFocus = null;

  function isBlocked() {
    const loader = document.getElementById('initial-loader');
    const sync = document.getElementById('sync-overlay');
    const update = document.getElementById('update-overlay-popup');
    const loaderVisible = loader && window.getComputedStyle(loader).display !== 'none';
    const syncVisible = sync && window.getComputedStyle(sync).display !== 'none';
    const updateVisible = update && window.getComputedStyle(update).display !== 'none';
    return loaderVisible || syncVisible || updateVisible;
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init(onBack) {
    backCallback = onBack;
    document.addEventListener('keydown', handleKey, true);

    document.addEventListener('blur', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
        e.target.readOnly = true;
      }
    }, true);
  }

  let lastNavTime = 0;
  const NAV_THROTTLE = 85;

  // ── Key Handler ────────────────────────────────────────────────────────────
  function handleKey(e) {
    if (isBlocked()) {
      e.preventDefault();
      return;
    }
    const key = e.key;
    const active = document.activeElement;
    const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');

    if (key === 'Backspace' || key === 'Escape' || key === 'GoBack') {
      if (isInput && key === 'Backspace') return;
      e.preventDefault();
      if (backCallback) backCallback();
      return;
    }

    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' ', 'Select', 'Ok', 'Center', 'dpad_center'].includes(key)) return;

    if (isInput) {
      if (key === 'ArrowLeft' || key === 'ArrowRight') return;
      if (key === 'ArrowUp' || key === 'ArrowDown') return;
    }

    if (key === 'Enter' || key === ' ' || key === 'Select' || key === 'Ok' || key === 'Center' || key === 'dpad_center') {
      if (active && active !== document.body) {
        if (isInput && (key === ' ' || key === 'Enter' || key === 'Select' || key === 'Ok')) {
          if (active.tagName === 'SELECT') return;
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

    const now = Date.now();
    const isArrow = key.startsWith('Arrow');
    const timeSinceLast = now - lastNavTime;

    if (isArrow) {
      if (timeSinceLast < 150) {
        document.body.classList.add('fast-nav');
        if (timeSinceLast < 65) document.body.classList.add('very-fast-nav');
      }
      if (timeSinceLast < NAV_THROTTLE) {
        e.preventDefault();
        return;
      }
      lastNavTime = now;
      clearTimeout(window._fastNavTimeout);
      window._fastNavTimeout = setTimeout(() => {
        document.body.classList.remove('fast-nav');
        document.body.classList.remove('very-fast-nav');
      }, 250);
    }

    e.preventDefault();

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

    const currentZone = active.closest('[data-nav-zone]')
      ? active.closest('[data-nav-zone]').getAttribute('data-nav-zone')
      : 'content';

    let best = null;
    let bestScore = Infinity;

    // ── Standard Search Pass ──
    for (const el of focusables) {
      if (el === active) continue;
      const elZone = el.closest('[data-nav-zone]')?.getAttribute('data-nav-zone') || 'content';
      
      const rect = el.getBoundingClientRect();
      const ex = rect.left + rect.width / 2;
      const ey = rect.top + rect.height / 2;
      const dx = ex - cx;
      const dy = ey - cy;

      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        // STAY in current zone segment during horizontal search
        if (elZone !== currentZone) continue;

        // --- Integrated Card-to-Card Lock ---
        const isActiveCard = active.classList.contains('card');
        const isTargetCard = el.classList.contains('card');
        if (isActiveCard && !isTargetCard) continue;
        // ------------------------------------

        if (Math.abs(dy) > Math.max(currentRect.height * 0.7, 50)) continue;
        if (key === 'ArrowRight' && dx <= 0) continue;
        if (key === 'ArrowLeft'  && dx >= 0) continue;
        const score = Math.abs(dx) + Math.abs(dy) * 5;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      else if (key === 'ArrowUp' || key === 'ArrowDown') {
        if (key === 'ArrowDown' && dy <= 0) continue;
        if (key === 'ArrowUp'   && dy >= 0) continue;

        // Area locking
        if (currentZone === 'tabs' || currentZone === 'notif') {
          if (elZone !== 'tabs' && elZone !== 'notif') continue;
          if (key === 'ArrowDown' && elZone === 'notif') lastTabFocus = active;
        } else {
          if (elZone === 'tabs' || elZone === 'notif') continue;
        }

        // Return to last tab from notif
        if (currentZone === 'notif' && key === 'ArrowUp' && elZone === 'tabs') {
          if (lastTabFocus && focusables.includes(lastTabFocus)) {
             best = lastTabFocus; break; 
          }
        }

        const score = Math.abs(dy) * 100 + Math.abs(dx);
        if (score < bestScore) { bestScore = score; best = el; }
      }
    }

    // ── FALLBACKS (Crossing Zones) ──
    if (!best) {
      // 1. ArrowLeft from content area → Sidebar
      if (key === 'ArrowLeft' && currentZone !== 'tabs' && currentZone !== 'notif' && !openModal) {
        const activeTab = document.querySelector('#tab-bar .tab-item.active');
        best = (activeTab && focusables.includes(activeTab)) ? activeTab : focusables.find(el => el.closest('#tab-bar'));
      }
      // 2. ArrowRight from sidebar → Content
      else if (key === 'ArrowRight' && (currentZone === 'tabs' || currentZone === 'notif') && !openModal) {
        best = focusables.find(el => {
          const z = el.closest('[data-nav-zone]')?.getAttribute('data-nav-zone');
          return z === 'content' || z === 'breadcrumb' || (!z && !el.closest('#tab-bar'));
        });
      }
    }

    if (best) {
      best.focus();
      // Ensure the card is centered horizontally to prevent scaling clipping at the screen edges.
      best.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }

  return { init };
})();

