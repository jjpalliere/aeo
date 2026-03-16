# terrain.run — Brand Style Guide

## Color Palette

### Bluer black
The base black is pushed toward blue for a cooler, deeper feel. The frost overlay uses `rgba(10,10,39,0.14)` — blue channel 4 points higher than R and G in the final blend — so the dark background reads as a subtle blue-black rather than neutral black.

### Redder whites
Light grays and off-whites carry a warm red tint: `--text2` (#f0ebeb) and `--text3` (#9f9a9a) have R elevated relative to G and B. This keeps the palette cohesive and avoids cold, clinical grays.

### Burnt orange accent
Primary accent and hero text use `rgb(238, 82, 24)` — a burnt orange that reads as bold but not harsh. Used for headlines, primary CTAs, and key emphasis.

### Washed greens
Success states, completion badges, and secondary accents use a muted green: `#a0be82` (rgb 160, 190, 130) — R = G−30, B = R−30. This gives a softer, less saturated green that fits the overall palette instead of a bright neon.

---

## Visual Effects

### Grain overlay
A film-grain texture is applied across the site via SVG fractal noise (dual feTurbulence layers blended). Opacity ~0.11, mix-blend-mode overlay. Used on both the frost overlay (3D pages) and as a standalone layer on dashboard, approve, and live views. Keeps the UI from feeling flat or sterile.

### Frost + blur
On homepage, run, and login, a frosted overlay sits over the 3D background: `backdrop-filter: blur(2.5px)` plus the blue-tinted semi-transparent fill. Creates depth and softens the animated backdrop.

### Flash effect (3D backdrop)
The scatter-plot background uses a camera-flash treatment: dots closer to the camera are brighter and slightly white-washed (overexposure), while distant dots fade into shadow. Blink groups add brief bright pulses across the dots. The result feels like a lit foreground against a receding dark background.

---

## Typography

### Fonts
- **Display:** Syne, Outfit — headers, hero, brand/logo
- **Body:** JetBrains Mono, Courier New — UI, data, labels, inputs

### Dashboard hierarchy
| Variable              | Use |
|-----------------------|-----|
| `--dash-section-header` | Section headers (e.g. [ OVERVIEW ]) — white |
| `--dash-col-title`      | Column titles (e.g. BRAND, MENTIONS) — red/accent |
| `--dash-row-content`    | Main row content — white |
| `--dash-row-muted`      | Smaller descriptive text (e.g. labels, "(you)") — darker |

### Font sizes
| Token     | Size  | Use |
|-----------|-------|-----|
| `--text-xs` | 12px | Labels, badges, tiny caps |
| `--text-sm` | 14px | Body, tables, inputs (root) |
| `--text-md` | 20px | Logo, emphasis |
| `--text-lg` | 24px | Section titles |
| `--text-xl` | 32px | Stat hero numbers |

---

## Summary

terrain.run uses a **bluer black**, **redder whites**, and a **burnt orange accent** for a warm-but-cool palette. **Washed greens** handle success and secondary states. The **grain overlay** and **frost/blur** add texture and depth; the **flash effect** on the 3D backdrop gives a focused, lit foreground against a darker background.
