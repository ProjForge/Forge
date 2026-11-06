(() => {
  const key = 'forge.workbench.theme.v1'
  const choices = ['light', 'dark', 'system']
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  let preference = 'system'
  try {
    const saved = localStorage.getItem(key)
    if (choices.includes(saved)) preference = saved
  } catch { /* The theme remains usable when browser storage is unavailable. */ }

  function apply() {
    document.documentElement.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference
    for (const button of document.querySelectorAll('[data-theme-choice]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference))
    }
  }

  apply()
  media.addEventListener('change', () => { if (preference === 'system') apply() })
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) {
      preference = choices.includes(event.newValue) ? event.newValue : 'system'
      apply()
    }
  })
  document.addEventListener('DOMContentLoaded', () => {
    for (const button of document.querySelectorAll('[data-theme-choice]')) {
      button.addEventListener('click', () => {
        preference = button.dataset.themeChoice
        try { localStorage.setItem(key, preference) } catch { /* Keep the current-session selection. */ }
        apply()
      })
    }
    apply()
  })
})()
