# Workbench appearance

The Workbench uses a horizontal navigation header, a floating project selector
and soft, rounded panels. The identity remains FORGE's charcoal `#0A0B0D`,
amber `#F0A83A`, bone `#F2F0EA` and steel `#9299A4` palette. Text and status
colors have theme-specific shades to maintain readable contrast.

## Themes

- **Claro** selects the light bone surfaces and dark monochrome official mark.
- **Oscuro** selects charcoal surfaces and the approved two-color mark.
- **Auto** follows the operating system, including changes while the page is open.

Auto is the default. The non-secret preference is stored in this browser under
`forge.workbench.theme.v1`, separate from project data and credentials. If
storage is unavailable, theme selection still works during the current session.
Changes propagate between same-origin tabs. A small external bootstrap applies
the effective theme before styles load, preserving the existing CSP.

## Tokens and behavior

`public/styles.css` owns the palette, surface, border, shadow and typography
tokens. `data-theme="light|dark"` on the root selects the effective colors.
`public/theme.js` owns theme preference only. UI logic and API contracts stay in
their existing layers; no external fonts or new runtime dependencies are used.

The active project appears first among matching projects. Detailed recovery
checks are expandable and keep their open state across health refreshes.
Keyboard focus, pressed theme state and navigation labels remain explicit.
Animations respect reduced-motion preferences.

## Verified locally

- Light/dark switching, reload persistence and Auto reacting to system changes.
- Empty onboarding with browser storage blocked, without JavaScript errors.
- Desktop and mobile layout at 320, 390, 768, 1280 and 1440 px; all four views
  checked on mobile; memory dialog opened and dismissed without writing data.
- Core foreground/background token pairs meet a 4.5:1 contrast ratio in both
  themes. This is a targeted check, not a complete WCAG certification.
- Workbench build, JavaScript syntax and 28 Workbench tests, including serving
  the new theme resources with the existing security headers.
