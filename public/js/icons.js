// Inline SVG icons (no icon font, no external requests). All use currentColor.
const s = (body, { vb = '0 0 24 24', fill = 'currentColor', stroke = null, sw = 1.8 } = {}) =>
  `<svg viewBox="${vb}" aria-hidden="true" focusable="false" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"` : ''}>${body}</svg>`;
const line = (body, sw = 1.8) => s(body, { fill: 'none', stroke: 'currentColor', sw });

const PETALS = `<path d="M20 4.2c-3.1 3.3-4.9 7-4.9 10.9 0 3.6 1.7 6.7 4.9 9.3 3.2-2.6 4.9-5.7 4.9-9.3 0-3.9-1.8-7.6-4.9-10.9z"/>
<path d="M18.3 26.3c-.5-3.6-2.4-6.4-5.6-7.6-2.9-1.1-6.2-.3-7.6 2.1-1.2 2.1-.4 4.7 1.8 5.5 1.7.6 3.4-.3 3.6-1.9.2-1.3-.9-2.3-2.1-2 1.6-1.4 4.2-1.3 6.1.3 1.3 1.1 2.1 2.4 2.4 3.6z"/>
<path d="M21.7 26.3c.5-3.6 2.4-6.4 5.6-7.6 2.9-1.1 6.2-.3 7.6 2.1 1.2 2.1.4 4.7-1.8 5.5-1.7.6-3.4-.3-3.6-1.9-.2-1.3.9-2.3 2.1-2-1.6-1.4-4.2-1.3-6.1.3-1.3 1.1-2.1 2.4-2.4 3.6z"/>
<rect x="12.6" y="26.2" width="14.8" height="2.6" rx="1.3"/>
<path d="M18.2 29.4h3.6c.2 2.6 1.3 4.4 3.4 5.8h-10.4c2.1-1.4 3.2-3.2 3.4-5.8z"/>`;
const PETAL_T = 'translate(20 20) scale(1.13) translate(-20 -20.6)';
let fleurSeq = 0;

/**
 * WealthQuest emblem: fleur-de-lis inside an ornamental ring. The ring is masked around the petals,
 * so the gap works on any background. `gradient` = gold logo; otherwise the fill is currentColor.
 */
export function fleur({ gradient = true, ring = true } = {}) {
  const id = `wqf${++fleurSeq}`;
  const fill = gradient ? `url(#${id}g)` : 'currentColor';
  const defs = `${gradient ? `<linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D8BE86"/><stop offset="1" stop-color="#B8955A"/></linearGradient>` : ''}${ring ? `<mask id="${id}m" maskUnits="userSpaceOnUse" x="0" y="0" width="40" height="40"><rect width="40" height="40" fill="#fff"/><g transform="${PETAL_T}" fill="#000" stroke="#000" stroke-width="2.2">${PETALS}</g></mask>` : ''}`;
  const ringEls = ring ? `<circle cx="20" cy="20" r="15" fill="none" stroke="${fill}" stroke-width="1.5" mask="url(#${id}m)"/>
<circle cx="20" cy="3.2" r="1.5"/><circle cx="20" cy="36.8" r="1.5"/><circle cx="3.2" cy="20" r="1.5"/><circle cx="36.8" cy="20" r="1.5"/>
<circle cx="8.1" cy="8.1" r="1.15"/><circle cx="31.9" cy="8.1" r="1.15"/><circle cx="8.1" cy="31.9" r="1.15"/><circle cx="31.9" cy="31.9" r="1.15"/>` : '';
  return `<svg class="fleur" viewBox="0 0 40 40" aria-hidden="true" focusable="false"><defs>${defs}</defs><g fill="${fill}">${ringEls}<g transform="${ring ? PETAL_T : 'translate(0 .4)'}">${PETALS}</g></g></svg>`;
}

export const icons = {
  // help-center categories (filled, teal)
  card: s('<path fill-rule="evenodd" d="M4.6 4.5h14.8A2.6 2.6 0 0 1 22 7.1v9.8a2.6 2.6 0 0 1-2.6 2.6H4.6A2.6 2.6 0 0 1 2 16.9V7.1a2.6 2.6 0 0 1 2.6-2.6zM2 8.6v2.6h20V8.6zM5.2 14.6v1.7h4.6v-1.7z"/>'),
  person: s('<circle cx="12" cy="7.2" r="4.2"/><path d="M3.8 21c0-4.4 3.7-7.2 8.2-7.2s8.2 2.8 8.2 7.2z"/>'),
  star: s('<path d="M12 2.6l2.9 6 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5L2.5 9.4l6.6-.8z"/>'),
  apps: s('<rect x="3" y="3" width="8" height="8" rx="2.4"/><rect x="13" y="3" width="8" height="8" rx="2.4"/><rect x="3" y="13" width="8" height="8" rx="2.4"/><path d="M16.1 13h1.8v3.1H21v1.8h-3.1V21h-1.8v-3.1H13v-1.8h3.1z"/>'),
  devices: s('<path d="M3 6.2A2.2 2.2 0 0 1 5.2 4H18v2.2H5.2v10.6H10V20H3z"/><rect x="12" y="8.5" width="9" height="12.5" rx="1.8"/>'),
  shield: s('<path fill-rule="evenodd" d="M12 2 4 5v6.1c0 5 3.4 9.6 8 10.9 4.6-1.3 8-5.9 8-10.9V5zm0 5.2a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zm-4 9.1c.6-2 2.2-3.2 4-3.2s3.4 1.2 4 3.2c-1 1.3-2.4 2.2-4 2.7-1.6-.5-3-1.4-4-2.7z"/>'),
  // UI
  chevronDown: line('<path d="M5.5 9l6.5 6.5L18.5 9"/>', 1.9),
  chevronRight: line('<path d="M9 5.5l6.5 6.5L9 18.5"/>', 1.7),
  sparkle: s('<path d="M9.5 3l1.9 5.2 5.1 1.9-5.1 1.9-1.9 5.2-1.9-5.2-5.1-1.9 5.1-1.9z"/><path d="M18 13.2l1 2.6 2.5 1-2.5 1-1 2.6-1-2.6-2.5-1 2.5-1z"/><path d="M18 2.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
  arrowLeft: line('<path d="M19 12H5M11 6l-6 6 6 6"/>', 1.9),
  arrowUp: line('<path d="M12 19V5M6 11l6-6 6 6"/>', 2),
  arrowRight: line('<path d="M5 12h14M13 6l6 6-6 6"/>', 1.9),
  x: line('<path d="M6 6l12 12M18 6L6 18"/>', 2),
  search: line('<circle cx="10.8" cy="10.8" r="6.8"/><path d="M20 20l-4.4-4.4"/>', 1.6),
  upload: line('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>', 1.9),
  file: line('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>', 1.6),
  check: line('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 2.2),
  chat: line('<path d="M20 11.5c0 4.1-3.6 7.5-8 7.5-1.2 0-2.3-.2-3.3-.6L4 20l1.3-3.9C4.5 14.8 4 13.2 4 11.5 4 7.4 7.6 4 12 4s8 3.4 8 7.5z"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" stroke-width="2.4"/>', 1.8),
  // back office
  calendar: line('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4M7.5 13h2M11 13h2M14.5 13h2M7.5 16.5h2M11 16.5h2"/>', 1.6),
  bell: line('<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>', 1.6),
  plus: line('<path d="M12 5v14M5 12h14"/>', 2.2),
  share: line('<circle cx="17.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18.5" r="2.5"/><path d="M8.7 10.7l6.6-3.9M8.7 13.3l6.6 3.9"/>', 1.7),
  panel: line('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>', 1.5),
  home: s('<path d="M12 3.2 2.5 11h2.7v9.3h5.1v-5.6h3.4v5.6h5.1V11h2.7z"/>'),
  earnings: s('<path d="M4 20.5h16v-2H4z"/><rect x="5" y="11" width="3.2" height="6" rx=".8"/><rect x="10.4" y="5" width="3.2" height="12" rx=".8"/><rect x="15.8" y="8.5" width="3.2" height="8.5" rx=".8"/>'),
  diamond: s('<path d="M6.5 3.5h11l4 5.3L12 20.5 2.5 8.8zM5.2 8.5h13.6L16.7 5.6H7.3z" fill-rule="evenodd"/>'),
  bonus: s('<path d="M12 2.8l2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.4 6.3 20.4l1.1-6.4L2.8 9.5l6.4-.9z"/>'),
  transactions: s('<path fill-rule="evenodd" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5zm4.8 2.8L5 12l2.8 2.7v-1.8h4.4v-1.8H7.8zm8.4 5.4L19 12l-2.8-2.7v1.8h-4.4v1.8h4.4z"/>'),
  billing: s('<path fill-rule="evenodd" d="M5 3h14v18l-2.3-1.6L14.3 21 12 19.4 9.7 21l-2.4-1.6L5 21zm3 4.5v1.8h8V7.5zm0 3.8v1.8h8v-1.8zm0 3.8v1.8h5v-1.8z"/>'),
  products: s('<path d="M12 3c-1.7 1.9-2.6 3.9-2.6 6 0 1.9.9 3.6 2.6 5 1.7-1.4 2.6-3.1 2.6-5 0-2.1-.9-4.1-2.6-6zM10.8 15c-.3-2-1.3-3.5-3-4.1-1.6-.6-3.4-.2-4.1 1.1-.7 1.2-.2 2.6 1 3 1 .3 1.9-.2 2-1 .1-.7-.5-1.3-1.1-1.1.9-.8 2.3-.7 3.3.2.7.6 1.1 1.3 1.3 1.9zM13.2 15c.3-2 1.3-3.5 3-4.1 1.6-.6 3.4-.2 4.1 1.1.7 1.2.2 2.6-1 3-1 .3-1.9-.2-2-1-.1-.7.5-1.3 1.1-1.1-.9-.8-2.3-.7-3.3.2-.7.6-1.1 1.3-1.3 1.9zM8 15.2h8v1.6H8zM11 17.6h2c.1 1.4.7 2.4 1.9 3.2H9.1c1.2-.8 1.8-1.8 1.9-3.2z"/>'),
  vip: s('<path d="M2.5 6h2.3l2 7.5 2-7.5h2.3l-3.2 11H5.7zM12.3 6h2.2v11h-2.2zM16 6h3.6c2.3 0 3.4 1.2 3.4 3.3 0 2.2-1.2 3.4-3.4 3.4h-1.4V17H16zm2.2 4.8h1.2c1 0 1.4-.5 1.4-1.4s-.4-1.4-1.4-1.4h-1.2z"/>'),
  cart: s('<path d="M2 3.5h2.8l.6 2.5H21l-2.2 8.2H7.6L7.9 15.5H19v2H6l.9-4L4.1 5.5H2z"/><circle cx="8" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/>'),
  tree: s('<rect x="9" y="2.5" width="6" height="5" rx="1.2"/><rect x="2.5" y="16.5" width="6" height="5" rx="1.2"/><rect x="15.5" y="16.5" width="6" height="5" rx="1.2"/><path d="M11.1 7.5h1.8v3.6h6.6v5.4h-1.8v-3.6H6.3v3.6H4.5v-5.4h6.6z"/>'),
  network: s('<path d="M12 2.5c-2.2 0-3.8 1.6-4 3.6-2.5.2-4.5 2.2-4.5 4.8 0 2.7 2.1 4.8 4.8 4.8h2.8v3.2H8.6v2h6.8v-2h-2.5v-3.2h2.8c2.7 0 4.8-2.1 4.8-4.8 0-2.6-2-4.6-4.5-4.8-.2-2-1.8-3.6-4-3.6z"/>'),
  members: s('<circle cx="6.2" cy="8.2" r="2.1"/><circle cx="10" cy="5" r="2.1"/><circle cx="14" cy="5" r="2.1"/><circle cx="17.8" cy="8.2" r="2.1"/><path d="M12 10.2c-3.4 0-6.2 4.3-6.2 7.3 0 1.8 1.3 2.7 2.9 2.7 1.4 0 2.2-.8 3.3-.8s1.9.8 3.3.8c1.6 0 2.9-.9 2.9-2.7 0-3-2.8-7.3-6.2-7.3z"/>'),
  link: s('<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c0-3.7 2.8-6.2 6.2-6.2 1.4 0 2.7.4 3.7 1.2l-2.6 2.6 1.2 1.2-1.3 1.2z"/><path d="M15.2 13.2a3 3 0 0 1 4.3 0 3 3 0 0 1 0 4.3l-1.6 1.6a3 3 0 0 1-4.3 0l1.3-1.3a1.2 1.2 0 0 0 1.7 0l1.6-1.6a1.2 1.2 0 0 0-1.7-1.7l-.6.6-1.3-1.3z"/>'),
  assets: s('<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm.9 4.5v1.2c1.4.2 2.4 1 2.6 2.3h-1.9c-.1-.6-.6-1-1.6-1-1 0-1.4.4-1.4.9 0 .6.5.8 1.8 1.1 1.9.4 3.2 1 3.2 2.7 0 1.4-1 2.3-2.7 2.5v1.3h-1.8v-1.3c-1.7-.2-2.8-1.2-2.9-2.6h1.9c.1.8.7 1.2 1.8 1.2s1.6-.4 1.6-1c0-.6-.5-.8-1.9-1.1-1.8-.4-3.1-1-3.1-2.6 0-1.3 1-2.2 2.5-2.4V7.5z"/>'),
  userPlus: s('<circle cx="10" cy="7.5" r="4"/><path d="M2.5 20.5c0-4.1 3.4-6.8 7.5-6.8 1.3 0 2.5.3 3.6.8-.7.9-1.1 2-1.1 3.2 0 1 .3 2 .8 2.8zM17.2 13.5h1.8v2.9h2.9v1.8H19v2.9h-1.8v-2.9h-2.9v-1.8h2.9z"/>'),
  flagUS: `<svg viewBox="0 0 30 20" aria-hidden="true"><rect width="30" height="20" rx="2.5" fill="#fff"/><g fill="#C8313E">${[0, 2, 4, 6, 8, 10, 12].map((i) => `<rect y="${(i * 20) / 13}" width="30" height="${20 / 13}"/>`).join('')}</g><rect width="13" height="${(20 / 13) * 7}" fill="#2A3D7F"/><rect width="30" height="20" rx="2.5" fill="none" stroke="rgba(0,0,0,.08)"/></svg>`,
};

export const CATEGORY_ICON = { card: icons.card, person: icons.person, star: icons.star, apps: icons.apps, devices: icons.devices, shield: icons.shield };
