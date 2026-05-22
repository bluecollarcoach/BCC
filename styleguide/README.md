# BCC Design System — drop-in stylesheet

Self-contained CSS that gives any site the same look as BCC Internal. No build step, no Tailwind, no JS.

## Files

| File | What it is |
| --- | --- |
| `bcc-theme.css` | The whole design system as CSS custom properties + utility classes. **Drop this into your site.** |
| `demo.html` | Self-contained preview page showing every component. Open it locally to see what's available before applying anywhere. |
| `README.md` | This file. |

## Preview locally

```powershell
cd C:\Users\Apric\Downloads\BCC-Internal\styleguide
start demo.html
```

Or just double-click `demo.html` in Explorer.

## Install on bluecollarcoach.us (WordPress)

Three options, pick whichever fits your workflow:

### Option 1 — Drop into your active theme (cleanest)

1. Connect to your WP host via SFTP (or use the Hosting panel's File Manager).
2. Upload `bcc-theme.css` to:
   ```
   wp-content/themes/<your-active-theme>/bcc-theme.css
   ```
3. In your theme's `functions.php`, add:
   ```php
   add_action('wp_enqueue_scripts', function () {
       // Inter — Google Fonts
       wp_enqueue_style(
           'inter',
           'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
           [],
           null
       );
       // BCC design system
       wp_enqueue_style(
           'bcc-theme',
           get_stylesheet_directory_uri() . '/bcc-theme.css',
           ['inter'],
           '1.0.0'
       );
   });
   ```

### Option 2 — Via a plugin (no theme edits)

If your current theme is locked or auto-updated, install the **"Custom CSS & JS"** plugin (or any code-injection plugin), then:

1. Paste the contents of `bcc-theme.css` into a new "Custom CSS" block.
2. Add this to the `<head>` section (Custom HTML block):
   ```html
   <link rel="preconnect" href="https://fonts.googleapis.com">
   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
   <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
   ```

### Option 3 — Block editor (Gutenberg) only, no global change

If you only want the look in specific pages/posts, paste the CSS into a **Custom HTML block** wrapped in `<style>…</style>`. Then wrap your block content in a `bcc-scope` div:

```html
<div class="bcc-scope">
  <div class="bcc-card bcc-card-accent">
    <div class="bcc-eyebrow">Featured</div>
    <h3>Why we coach</h3>
    <p>…</p>
    <a class="bcc-btn" href="/contact">Book a call</a>
  </div>
</div>
```

## Class reference (most-used)

| Class | What it does |
| --- | --- |
| `bcc-scope` | Wrap any container in this to opt into the BCC font + base styles. Won't affect anything outside. |
| `bcc-container` | Centred max-width container (1200px) with responsive padding. |
| `bcc-grid` | Auto-fitting CSS Grid; cards/items min 280px wide. |
| `bcc-chrome-backdrop` | Full dark gradient background (sign-in pages, hero strips). |
| `bcc-card` | White card with shadow + border. |
| `bcc-card-accent` | Adds the 3px amber stripe along the top. |
| `bcc-btn`, `bcc-btn-outline`, `bcc-btn-ghost`, `bcc-btn-danger` | Button variants. Append `bcc-btn-lg` or `bcc-btn-sm` for size. |
| `bcc-input`, `bcc-textarea`, `bcc-select`, `bcc-label` | Form controls. |
| `bcc-badge` (+ `bcc-badge-muted/success/warning/danger`) | Pill-shaped status tags. |
| `bcc-eyebrow` | Small uppercase amber label above a heading. |
| `bcc-text-muted`, `bcc-text-accent` | Color helpers. |
| `bcc-sidebar` + `bcc-active` | Dark-chrome sidebar pattern. |

## Recoloring without touching the CSS file

All colors live as CSS custom properties on `:root`. To recolor a single page or the whole site, override them in your own stylesheet:

```css
:root {
  /* Make it BCC Connect gold instead of amber */
  --bcc-accent: #c5a55a;
  --bcc-accent-hover: #b8944f;

  /* Lighter chrome */
  --bcc-chrome-bg: #2b2b2b;
}
```

Nothing in `bcc-theme.css` needs to change — every component re-themes itself off these tokens.

## Browser support

Modern Chromium, Firefox, Safari. Custom properties + CSS Grid required (so IE11 is out — irrelevant in 2026 but worth noting).
