// Loaded synchronously from <head> so the first paint already has the right
// theme; an inline copy would need 'unsafe-inline' in the Content-Security-Policy.
try {
  const p = JSON.parse(localStorage.getItem('devchat.prefs.v1') || '{}');
  document.documentElement.dataset.theme = p.theme
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
} catch {
  /* a blocked or corrupt localStorage just keeps the markup's default theme */
}

// The backdrop is here for the same reason: style.js runs at the end of body, so a
// saved plain background or picture would otherwise appear as aurora for a frame.
// style.js reads the same key again and is the one that validates for real; this
// only has to be conservative enough not to paint something nobody chose.
try {
  const root = document.documentElement;
  const look = JSON.parse(localStorage.getItem('devchat.look.v1') || '{}');
  const bg = ['aurora', 'grid', 'plain', 'image'].includes(look.bg) ? look.bg : 'aurora';
  root.dataset.bg = bg;
  const dim = Number(look.dim);
  root.style.setProperty('--look-dim', `${Number.isFinite(dim) ? Math.min(80, Math.max(0, dim)) : 0}%`);
  // The picture can be an https address or one re-encoded from this device, and both
  // end up inside url("…"), so both are checked for the characters that would break
  // out of it. style.js is the one that validates for real.
  const address = /^https:\/\/[A-Za-z0-9.\-_%~!?*'+,;=&#/@:]{4,400}$/.test(String(look.image || ''))
    ? look.image : '';
  const kept = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(String(look.file || ''))
    && String(look.file).length <= 1000000 ? look.file : '';
  if (bg === 'image' && (address || kept)) {
    root.style.setProperty('--look-image', `url("${address || kept}")`);
  }
} catch {
  /* no localStorage, no backdrop — the stylesheet keeps the aurora default */
}
