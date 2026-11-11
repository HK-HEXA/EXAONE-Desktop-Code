# README brand artwork

The four SVG banners combine the existing app symbols (`assets/desktop.svg`, `assets/code.svg`) with the official EXAONE wordmark path (`assets/wordmark.svg`). Original wordmark attribution is documented in `assets/README.md`; the EXAONE name and wordmark are excluded from this project's Unlicense.

Light/dark variants use the existing app palette. Mobile variants stack the two lockups so both names remain readable on narrow screens. All artwork is local, uses plain SVG without scripts or external resources, and includes accessible titles.

Regenerate after changing app symbols with:

```sh
node scripts/generate-readme-brand.cjs
```
