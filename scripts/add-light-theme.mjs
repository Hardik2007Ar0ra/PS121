/**
 * One-shot codemod: converts the hardcoded dark palette to semantic CSS custom
 * properties and adds a light theme.
 *
 * The stylesheet held 171 unique hardcoded colours across 246 references, which
 * is why the app was dark-only: there was no palette to invert. Rather than
 * hand-patch 246 sites (and miss some, silently leaving a dark speck in a light
 * page) this rewrites them through an explicit, reviewable map and then fails
 * loudly if any colour in either file is unaccounted for.
 *
 *   node scripts/add-light-theme.mjs
 *
 * Run once. It is kept in the repo because the token map is the documentation of
 * what the palette means, and because a future colour must be added as a token
 * rather than as a hex literal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every colour in style.css, grouped by the role it plays.
 *
 * Values are chosen so that light mode keeps at least 4.5:1 contrast for text
 * and 3:1 for large text and UI borders. The muted greys are the tightest
 * constraint: `#6f756a` on white is 4.9:1, which is why they stop there rather
 * than going lighter for a more "airy" look.
 */
/**
 * Dark palette: the original values from the pre-token stylesheet.
 */
const DARK = {
  --bg:#131214,
  --surface:#1d1a1d,
  --panel:#201d20,
  --card:#252125,
  --raised:#2a2629,
  --raised-2:#313930,
  --input:#282428,
  --sunken:#2b272b,
  --sunken-2:#252b26,
  --deep:#151315,
  --hover:#252c25,
  --row-hover:#232a23,
  --brand:#252f28,
  --track:#343c35,
  --line:#343b34,
  --line-2:#424b42,
  --fg-hi:#f0f1ec,
  --fg:#e6e9e4,
  --fg-2:#d9ded6,
  --fg-3:#c5ccc1,
  --fg-4:#9da59b,
  --gold:#d5a53c,
  --gold-tx:#f0c46f,
  --gold-ln:#685532,
  --gold-bg:#34291f,
  --gold-solid:#a87925,
  --on-gold:#171913,
  --ok:#82b980,
  --ok-ln:#4e6946,
  --ok-bg:#222c24,
  --danger:#e05246,
  --danger-ln:#7b4840,
  --danger-bg:#33211e,
  --teal:#9bd0b5,
  --teal-ln:#426357,
  --teal-bg:#262b29,
  --shadow:rgba(0,0,0,.2),
  --shadow-lg:rgba(0,0,0,.4),
  --scrim:rgba(7,9,7,.79),
  --ring:rgba(255,255,255,.33),
  --marker-line:#131813,
};

/**
 * Light palette.
 *
 * Contrast notes: the muted greys stop at #6f756a because that is 4.9:1 on white
 * and going lighter for a more "airy" look would push small labels below the WCAG
 * 4.5:1 minimum. Gold darkens to #a87925 so it stays legible as text rather than
 * only as a fill.
 */
const LIGHT = {
  --bg:#f2f3ef,
  --surface:#ffffff,
  --panel:#ffffff,
  --card:#f7f8f4,
  --raised:#f4f5f1,
  --raised-2:#e9ebe3,
  --input:#ffffff,
  --sunken:#f0f1ec,
  --sunken-2:#eceee7,
  --deep:#e9ebe4,
  --hover:#eceee8,
  --row-hover:#eef0ea,
  --brand:#e8eee6,
  --track:#dcdfd7,
  --line:#dde0d8,
  --line-2:#c8cdc1,
  --fg-hi:#14170f,
  --fg:#262a22,
  --fg-2:#3a3f34,
  --fg-3:#565c4f,
  --fg-4:#6f756a,
  --gold:#a87925,
  --gold-tx:#7d5c14,
  --gold-ln:#d9c288,
  --gold-bg:#fbf3e0,
  --gold-solid:#a87925,
  --on-gold:#171913,
  --ok:#3f6b35,
  --ok-ln:#b9d3b1,
  --ok-bg:#eaf2e6,
  --danger:#c0392b,
  --danger-ln:#e0b5ae,
  --danger-bg:#fbeae7,
  --teal:#2f6d55,
  --teal-ln:#b0cfc4,
  --teal-bg:#e7f1ee,
  --shadow:rgba(20,24,18,.07),
  --shadow-lg:rgba(20,24,18,.16),
  --scrim:rgba(7,9,7,.45),
  --ring:rgba(24,28,20,.22),
  --marker-line:#2b2f26,
};

/** hex (lowercase) -> token. Every hex in the stylesheet must appear here. */
const CSS_MAP = {
  // page + major surfaces
  '#131214': '--bg',
  '#1d1a1d': '--surface',
  '#201d20': '--panel',
  '#252125': '--card',
  '#2a2629': '--raised',
  '#313930': '--raised-2',
  '#292529': '--raised',
  '#282428': '--input',
  '#2b272b': '--sunken',
  '#252b26': '--sunken-2',
  '#151315': '--deep',
  '#252c25': '--hover',
  '#232a23': '--row-hover',
  '#252f28': '--brand',
  '#343c35': '--track',

  // borders
  '#353b34': '--line',
  '#343b34': '--line',
  '#394139': '--line',
  '#303730': '--line',
  '#394039': '--line',
  '#353d35': '--line',
  '#363e35': '--line',
  '#424b42': '--line-2',
  '#424940': '--line-2',
  '#414941': '--line-2',
  '#414a41': '--line-2',
  '#3e473e': '--line-2',
  '#3c453c': '--line-2',
  '#3d463d': '--line-2',
  '#3c463c': '--line-2',
  '#3c373c': '--line-2',
  '#444c43': '--line-2',
  '#3d443c': '--line-2',
  '#373237': '--line-2',
  '#4a5249': '--line-2',
  '#4b554a': '--line-2',
  '#4b5c42': '--line-2',
  '#555e53': '--line-2',
  '#737c6d': '--line-2',
  '#414940': '--line-2',

  // text
  '#e6e9e4': '--fg',
  '#eee': '--fg-hi',
  '#ecefe8': '--fg-hi',
  '#ecefe9': '--fg-hi',
  '#ecefe7': '--fg-hi',
  '#f0f1ec': '--fg-hi',
  '#e8ebe5': '--fg-hi',
  '#fff': '--fg-hi',
  '#d9ded6': '--fg-2',
  '#e0e5dd': '--fg-2',
  '#e1e6dd': '--fg-2',
  '#e1e7dc': '--fg-2',
  '#e1dce1': '--fg-2',
  '#e4e8df': '--fg-2',
  '#e4e1dc': '--fg-2',
  '#d8ddd5': '--fg-2',
  '#d7ddd2': '--fg-2',
  '#c5ccc1': '--fg-3',
  '#c1c8bc': '--fg-3',
  '#c1c8bd': '--fg-3',
  '#c0c7bd': '--fg-3',
  '#bfc6bb': '--fg-3',
  '#bfc5bb': '--fg-3',
  '#bfc6bc': '--fg-3',
  '#bdc5ba': '--fg-3',
  '#bac2b6': '--fg-3',
  '#b9c0b7': '--fg-3',
  '#b4bcae': '--fg-3',
  '#abb2a8': '--fg-3',
  '#afb7ac': '--fg-3',
  '#b9b1b8': '--fg-3',
  '#a39ba0': '--fg-3',
  '#a9b1a6': '--fg-4',
  '#aab1a8': '--fg-4',
  '#aab1a9': '--fg-4',
  '#aeb5ac': '--fg-4',
  '#aeb6aa': '--fg-4',
  '#aeb6ab': '--fg-4',
  '#aeb7aa': '--fg-4',
  '#a6ada3': '--fg-4',
  '#a6aea3': '--fg-4',
  '#a5ada2': '--fg-4',
  '#a3aba0': '--fg-4',
  '#a2aa9f': '--fg-4',
  '#9da59b': '--fg-4',
  '#9ca49b': '--fg-4',
  '#9ca59a': '--fg-4',
  '#9ba399': '--fg-4',
  '#9ba499': '--fg-4',
  '#9fa89d': '--fg-4',
  '#9fa79d': '--fg-4',
  '#9ea69b': '--fg-4',
  '#98a196': '--fg-4',

  // gold
  '#d5a53c': '--gold',
  '#d4a33e': '--gold',
  '#d5a13b': '--gold',
  '#d4a03a': '--gold',
  '#d7a441': '--gold',
  '#d49a35': '--gold',
  '#d8a447': '--gold',
  '#dc9f35': '--gold',
  '#e0a841': '--gold',
  '#d9ad51': '--gold',
  '#f0c46f': '--gold-tx',
  '#ebc56f': '--gold-tx',
  '#ecc364': '--gold-tx',
  '#e7ba58': '--gold-tx',
  '#e7b75f': '--gold-tx',
  '#e4b559': '--gold-tx',
  '#e3c073': '--gold-tx',
  '#e4c477': '--gold-tx',
  '#edc671': '--gold-tx',
  '#dfba7e': '--gold-tx',
  '#d3aa57': '--gold-tx',
  '#c6b78f': '--gold-tx',
  '#685532': '--gold-ln',
  '#765c32': '--gold-ln',
  '#77603a': '--gold-ln',
  '#8c6b32': '--gold-ln',
  '#917542': '--gold-ln',
  '#88703e': '--gold-ln',
  '#70552e': '--gold-ln',
  '#796038': '--gold-ln',
  '#b78436': '--gold-ln',
  '#67554b': '--gold-ln',
  '#f0ca77': '--gold-tx',
  '#d4a23f': '--gold',
  '#34291f': '--gold-bg',
  '#372a20': '--gold-bg',
  '#332919': '--gold-bg',
  '#382a20': '--gold-bg',
  '#362a27': '--gold-bg',
  '#403127': '--gold-bg',
  '#453528': '--gold-bg',
  '#372f20': '--gold-bg',
  '#2c2721': '--gold-bg',
  '#302d22': '--gold-bg',
  '#302b30': '--gold-bg',
  '#a87925': '--gold-solid',
  '#bd8b34': '--gold-solid',
  '#bf923f': '--gold-solid',
  '#9f7a35': '--gold-solid',
  '#171913': '--on-gold',

  // status
  '#82b980': '--ok',
  '#86b57d': '--ok',
  '#79ad6f': '--ok',
  '#77bb74': '--ok',
  '#8fbb79': '--ok',
  '#9bcc82': '--ok',
  '#4e6946': '--ok-ln',
  '#222c24': '--ok-bg',
  '#303b32': '--ok-bg',
  '#292a25': '--ok-bg',
  '#e05246': '--danger',
  '#e05850': '--danger',
  '#e25a4e': '--danger',
  '#e35950': '--danger',
  '#ee8374': '--danger',
  '#7b4840': '--danger-ln',
  '#8a5948': '--danger-ln',
  '#33211e': '--danger-bg',
  '#302a2a': '--danger-bg',
  '#9bd0b5': '--teal',
  '#426357': '--teal-ln',
  '#262b29': '--teal-bg',

  // elevation + map
  '#131813': '--marker-line',
};

/** JSX colours, which SVG and Leaflet both accept as var() strings. */
const JSX_MAP = {
  '#d49a35': '--gold',
  '#dba544': '--gold',
  '#e5b14d': '--gold',
  '#ddb04e': '--gold-tx',
  '#f3cb7c': '--gold-tx',
  '#9ca49e': '--fg-4',
  '#89918a': '--fg-3',
  '#aaa': '--fg-3',
  '#333a35': '--line',
  '#424942': '--line-2',
  '#eee': '--fg-hi',
  '#161a17': '--fg-hi',
  '#202520': '--sunken',
  '#f08a7c': '--danger',
  '#d3443c': '--danger',
  '#e05a50': '--danger',
};

// Non-hex colours that also need tokenising.
const CSS_LITERAL = [
  ['#0003', 'var(--shadow)'],
  ['#0008', 'var(--shadow)'],
  ['#000a', 'var(--shadow-lg)'],
  ['#070907c9', 'var(--scrim)'],
  ['#ffffff55', 'var(--ring)'],
];

function tokenBlock(values, indent = '') {
  return Object.entries(values)
    .map(([name, value]) => `${indent}${name}:${value};`)
    .join('\n');
}

/**
 * Rewrites `color`/`background` etc. in a stylesheet, and leaves alone the colour
 * keywords (`transparent`, `currentColor`) plus anything already tokenised.
 */
function rewriteCss(source) {
  let out = source;

  // Alpha-shorthand and longhand literals first, so the 6-digit matcher below
  // cannot chew the leading 6 characters off an 8-digit value.
  for (const [literal, replacement] of CSS_LITERAL) {
    out = out.split(literal).join(replacement);
  }

  out = out.replace(/#[0-9a-fA-F]{3,8}\b/g, (match) => {
    const token = CSS_MAP[match.toLowerCase()];
    if (!token) throw new Error(`unmapped colour in style.css: ${match}`);
    return `var(${token})`;
  });

  return out;
}

function rewriteJsx(source) {
  return source.replace(/#[0-9a-fA-F]{3,8}\b/g, (match) => {
    const token = JSX_MAP[match.toLowerCase()];
    if (!token) throw new Error(`unmapped colour in App.jsx: ${match}`);
    return `var(${token})`;
  });
}

const HEADER = `/* ------------------------------------------------------------------ *\
 * Theme tokens
 *
 * Colour is expressed as roles, not as hex values, so a light theme is a second
 * block of assignments rather than a second copy of every rule. The app is dark
 * by default because that is how it was designed; light mode is opt-in via
 * \`data-theme="light"\` on <html>, set and persisted by the toggle in App.jsx.
 *
 * Adding a colour means adding a token here. A hex literal in a rule is a bug:
 * it cannot respond to the theme.
 * ------------------------------------------------------------------ */
:root {
  color-scheme: dark;
${tokenBlock(DARK, '  ')}
}

[data-theme='light'] {
  color-scheme: light;
${tokenBlock(LIGHT, '  ')}
}

/* The switch is a real control, so it needs a visible focus ring in both themes
   rather than relying on the browser default against a dark background. */
.theme-toggle:focus-visible {
  outline: 2px solid var(--gold);
  outline-offset: 2px;
}
`;

// --- stylesheet -------------------------------------------------------------
const cssPath = path.join(root, 'src', 'style.css');
const css = fs.readFileSync(cssPath, 'utf8');
if (css.includes(':root{font-family')) {
  // The old sheet opened with its own :root. That rule set font-family and
  // colours, and the colours are now tokens, so the declaration is reduced to the
  // font stack and the token block is prepended above it.
  const rewritten = rewriteCss(css);
  const bodyStart = rewritten.indexOf(':root{font-family');
  const declaration = rewritten.slice(bodyStart);
  const cleaned = declaration
    .replace(/:root\{([^}]*)\}/, (_m, inner) => {
      const kept = inner
        .split(';')
        .filter((piece) => /font-family|font-synthesis/.test(piece))
        .join(';');
      return `:root{${kept}}`;
    })
    // body carried the page background as a literal; that is now --bg.
    .replace(/background:var\(--bg\);color:var\(--fg\)/, 'background:var(--bg);color:var(--fg)');
  fs.writeFileSync(cssPath, `${HEADER}\n${cleaned}`, 'utf8');
  console.log('style.css: tokenised, theme blocks added');
} else {
  throw new Error('style.css does not look like the expected file; refusing to guess');
}

// --- jsx -------------------------------------------------------------------
const jsxPath = path.join(root, 'src', 'App.jsx');
const jsx = fs.readFileSync(jsxPath, 'utf8');
fs.writeFileSync(jsxPath, rewriteJsx(jsx), 'utf8');
console.log('App.jsx: inline chart/map colours tokenised');

console.log(`tokens: ${Object.keys(DARK).length}`);