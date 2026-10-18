// Loaded synchronously from <head> so the first paint already has the right
// theme; an inline copy would need 'unsafe-inline' in the Content-Security-Policy.
try {
  const p = JSON.parse(localStorage.getItem('devchat.prefs.v1') || '{}');
  document.documentElement.dataset.theme = p.theme
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
} catch {
  /* a blocked or corrupt localStorage just keeps the markup's default theme */
}
