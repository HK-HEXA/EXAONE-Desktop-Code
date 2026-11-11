# EXAONE app identity

Reference: https://showroom.exaone.ai/en (inspected 2026-11-11).

- `wordmark.svg`: EXAONE lettering extracted from the official `/images/logoMain.svg`; the Showroom descriptor was removed. The original path geometry is preserved.
- `code.svg`: app-specific terminal-window symbol, authored as vector paths.
- `desktop.svg`: app-specific monochrome E mark.
- `desktop.png`: 256 px Windows window icon, matching the Desktop E geometry.

Code uses the official wordmark with a separate Code descriptor, with a small lavender terminal-window symbol drawn in continuous strokes. The terminal displays EXAONE Code and session details inside a thin lavender frame.

The app-specific marks are adaptations for these local clients, not official product logos. The wordmark uses a CSS mask to follow the current light/dark foreground. User-provided `logo.*` files continue to override the default app marks.
