(function() {
  const STORAGE_KEY = 'hamser-diary-theme';

  function getTheme() {
    return localStorage.getItem(STORAGE_KEY) || 'dark';
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
    updateToggleIcon(theme);
  }

  function updateToggleIcon(theme) {
    const btn = document.querySelector('.theme-toggle');
    if (btn) {
      btn.textContent = theme === 'dark' ? '\u2600\uFE0F \uB77C\uC774\uD2B8' : '\uD83C\uDF19 \uB2E4\uD06C';
    }
  }

  // Apply theme immediately to prevent FOUC
  setTheme(getTheme());

  document.addEventListener('DOMContentLoaded', function() {
    const btn = document.querySelector('.theme-toggle');
    if (btn) {
      updateToggleIcon(getTheme());
      btn.addEventListener('click', function() {
        const current = getTheme();
        setTheme(current === 'dark' ? 'light' : 'dark');
      });
    }
  });
})();
