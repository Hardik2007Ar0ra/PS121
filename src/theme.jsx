/**
 * Theme switching.
 *
 * Colour lives in CSS custom properties (see the token block at the top of
 * style.css), so switching themes is a single attribute flip on <html> rather than
 * a re-render of the tree. This module owns three things: what the current theme
 * is, writing it to localStorage, and getting it onto the DOM before first paint.
 *
 * That last part is why index.html also carries a tiny inline script. React mounts
 * after the first paint, so setting `data-theme` from an effect alone means a user
 * who chose light mode gets a flash of dark on every reload. The inline script
 * reads the same key and the same media query, so the two cannot disagree.
 */

import { useCallback, useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

const STORAGE_KEY = 'nwis_theme';
const DARK = 'dark';
const LIGHT = 'light';

function stored() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === DARK || value === LIGHT ? value : null;
  } catch {
    // Private browsing modes can throw on localStorage access. Falling back to
    // the OS preference is better than failing to render at all.
    return null;
  }
}

function systemTheme() {
  if (typeof window === 'undefined' || !window.matchMedia) return DARK;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? LIGHT : DARK;
}

export function currentTheme() {
  return stored() ?? systemTheme();
}

/**
 * Applies the theme to the document.
 *
 * `color-scheme` in the stylesheet does the heavy lifting for native widgets —
 * scrollbars, date pickers, the autofill background. This only updates the theme
 * colour meta tag so mobile browser chrome matches the page.
 */
export function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === LIGHT ? '#f2f3ef' : '#131214');
}

/** Reads the theme, follows the OS while unset, and writes an explicit choice. */
export function useTheme() {
  const [theme, setTheme] = useState(currentTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // A theme that cannot be persisted still applies for this session.
    }
  }, [theme]);

  // While the user has made no explicit choice, follow the OS if it changes.
  useEffect(() => {
    if (stored() || !window.matchMedia) return undefined;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (event) => setTheme(event.matches ? LIGHT : DARK);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const toggle = useCallback(() => setTheme((t) => (t === LIGHT ? DARK : LIGHT)), []);

  return { theme, setTheme, toggle, isLight: theme === LIGHT };
}

/**
 * The switch itself.
 *
 * Deliberately a plain button with an accessible name and a pressed state rather
 * than an icon-only control: the sun/moon glyph is a supplement to the label, not
 * a substitute for it.
 */
export function ThemeToggle() {
  const { theme, toggle, isLight } = useTheme();

  return (
    <button
      type="button"
      className="btn theme-toggle"
      onClick={toggle}
      aria-pressed={isLight}
      aria-label={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
      title={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
    >
      {isLight ? <Moon size={16} /> : <Sun size={16} />}
      <span>{isLight ? 'Dark' : 'Light'}</span>
    </button>
  );
}

export { DARK, LIGHT, STORAGE_KEY };