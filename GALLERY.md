# Luxury Home Gallery — WordPress Showcase

An interactive, mobile-first portfolio gallery for a luxury home‑improvement
website. Everything lives in a single file (`gallery.html`) — markup, styles and
script — so it drops cleanly into WordPress without a build step or plugin.

## Features

- **Six category filters** — New Homes, Additions, Renovations, Kitchens,
  Bathrooms, Exteriors (plus *All*). Empty categories hide themselves; counts
  show how many projects are in each.
- **Smooth FLIP filtering** — tiles physically slide to their new positions when
  you change filters instead of snapping, which keeps attention on the work.
- **Full‑screen lightbox** — keyboard (← → Esc), on‑screen arrows, a counter,
  focus‑trapping for accessibility, and **swipe** navigation on touch devices.
- **Before / After sliders** — any project with a `ba` field becomes a draggable
  reveal, in both the grid (badge) and the lightbox. Great for renovations.
- **Retention touches** — staggered scroll reveals, image ken‑burns on hover,
  a varied (feature / tall / wide) masonry rhythm, and a closing call‑to‑action.
- **Mobile‑first** — single‑column layout, captions always visible on touch,
  44px+ tap targets, horizontally‑scrollable snap filter bar, `safe-area`
  insets for notched phones, and `prefers-reduced-motion` support.
- **Shareable filters** — the active category is written to the URL hash
  (e.g. `…/portfolio/#kitchens`) so links open pre‑filtered.
- **Theme‑safe** — every selector is namespaced under `.lhg`, so it won't fight
  your WordPress theme's CSS.

## Quick preview

This repo's dev server already hosts static files, so you can preview locally:

```bash
npm start        # then open http://localhost:8000/gallery.html
```

## Add it to WordPress

Pick whichever fits your setup.

### Option A — Custom HTML block (fastest, no FTP)

1. Open `gallery.html` and copy **everything inside `<style> … </style>`** into a
   *Custom HTML* block at the top of your page (or into Appearance → Customize →
   Additional CSS).
2. Copy the markup between the two
   `COPY FROM HERE … / … TO HERE` comment banners (the `<section class="lhg">…`)
   into the same or a following *Custom HTML* block.
3. Copy the `<script> … </script>` block into a *Custom HTML* block at the bottom
   of the page.

> Tip: Block themes sometimes strip `<script>`. If your gallery shows but the
> filters/lightbox don't work, use Option B or the snippet below.

### Option B — iframe embed (most isolated)

Upload `gallery.html` to your media/uploads folder (or any host) and embed it:

```html
<iframe src="/wp-content/uploads/gallery.html"
        style="width:100%;border:0;height:1600px" loading="lazy"
        title="Project gallery"></iframe>
```

### Option C — Page template / theme partial

Copy `gallery.html`'s `<style>`, `<section class="lhg">` and `<script>` blocks
into a custom page template (`page-portfolio.php`) or a reusable pattern. This is
the best route if you want PHP to generate the project list from a Custom Post
Type (see below).

## Use your own photos

Edit the `PROJECTS` array near the bottom of the file. Each project:

```js
{
  title: "Chef's Kitchen Remodel",
  cats: ["kitchens", "renovations"],          // one or more filter keys
  location: "Ridgewood, NJ",
  year: 2024,
  size: "feature",                            // optional: feature | tall | wide
  img:  "/wp-content/uploads/kitchen-after.jpg",
  thumb:"/wp-content/uploads/kitchen-thumb.jpg",   // optional smaller grid image
  ba:   { before: "…/before.jpg", after: "…/after.jpg" },  // optional slider
  desc: "Gut renovation opening a cramped galley into a light-filled cook's kitchen."
}
```

Valid `cats` keys: `new-homes`, `additions`, `renovations`, `kitchens`,
`bathrooms`, `exteriors`. The demo images point at Unsplash so the gallery looks
finished out of the box — **replace them with your own `/wp-content/uploads/…`
URLs** for production. If an image ever fails to load, the tile falls back to a
warm gradient rather than a broken icon.

## Re-skin it

Change the CSS variables at the top of the `.lhg { … }` rule:

```css
--lhg-gold:    #b08d4f;   /* accent / brass        */
--lhg-ink:     #16140f;   /* headings & dark UI    */
--lhg-bg:      #faf7f1;   /* page background       */
--lhg-radius:  16px;      /* corner rounding       */
```

Fonts default to *Cormorant Garamond* (headings) + *Inter* (body), loaded from
Google Fonts with a system‑font fallback if offline.

## Optional: drive it from a Custom Post Type

If you'd rather manage projects in the WP admin, register a `project` CPT with a
`category` taxonomy, then have your template print the `PROJECTS` array from a
`WP_Query` (map each post's featured image to `img`/`thumb` and its terms to
`cats`). The front‑end engine stays exactly the same.
