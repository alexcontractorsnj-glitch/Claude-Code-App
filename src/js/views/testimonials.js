// ============================================================================
//  testimonials.js — Testimonial carousel. One quote at a time with prev/next
//  arrows, clickable dot indicators, keyboard (←/→) support, and an auto-play
//  timer that pauses on hover/focus. State lives on ctx so the slide and
//  play/pause survive re-renders triggered by the shared store.
// ============================================================================
import { el, clear } from '../utils.js';

// Customer quotes for BuildFlow. Kept in-module (no store needed — these are
// static marketing content, not user-editable schedule data).
export const TESTIMONIALS = [
  {
    quote: 'BuildFlow replaced three spreadsheets and a whiteboard. We caught a two-week slip on the curtain wall before it ever hit the critical path.',
    name: 'Maria Delgado',
    role: 'Senior Project Manager',
    company: 'Cornerstone Builders',
    rating: 5,
  },
  {
    quote: 'The crew-leveling view alone paid for itself. We stopped double-booking our framing crew across the two towers in week one.',
    name: 'Darnell Price',
    role: 'Operations Director',
    company: 'Meridian Construction Group',
    rating: 5,
  },
  {
    quote: 'Baselines and finish-variance KPIs turned our owner meetings around. Instead of arguing about dates, we point at the slip and talk recovery.',
    name: 'Sofia Lindqvist',
    role: 'VP of Field Operations',
    company: 'Northgate Development',
    rating: 5,
  },
  {
    quote: 'Daily reports, RFIs, and punch lists in one place means our supers spend the morning building, not chasing paperwork.',
    name: 'James Okafor',
    role: 'General Superintendent',
    company: 'Atlas Commercial',
    rating: 4,
  },
  {
    quote: 'Rolled it out across nine active projects in a month. The fact that it just runs in the browser with zero install made IT very happy.',
    name: 'Emily Tran',
    role: 'Director of PMO',
    company: 'Summit Infrastructure',
    rating: 5,
  },
];

const AUTOPLAY_MS = 6000;

export function renderTestimonials(mount, ctx) {
  clear(mount);

  // --- Slide state on ctx (survives store-driven re-renders) ----------------
  if (typeof ctx.testimonialSlide !== 'number') ctx.testimonialSlide = 0;
  if (typeof ctx.testimonialPlaying !== 'boolean') ctx.testimonialPlaying = true;
  const count = TESTIMONIALS.length;
  ctx.testimonialSlide = ((ctx.testimonialSlide % count) + count) % count;

  const stage = el('div', { class: 'tm-stage' });
  const dotsRow = el('div', { class: 'tm-dots' });

  // Clear any timer from a previous render so we never stack intervals.
  if (ctx._testimonialTimer) { clearInterval(ctx._testimonialTimer); ctx._testimonialTimer = null; }

  function go(to, dir) {
    const next = ((to % count) + count) % count;
    if (next === ctx.testimonialSlide) return;
    ctx.testimonialSlide = next;
    paint(dir || (next > to ? 'right' : 'left'));
  }
  const nextSlide = () => go(ctx.testimonialSlide + 1, 'right');
  const prevSlide = () => go(ctx.testimonialSlide - 1, 'left');

  function restartTimer() {
    if (ctx._testimonialTimer) { clearInterval(ctx._testimonialTimer); ctx._testimonialTimer = null; }
    if (ctx.testimonialPlaying) ctx._testimonialTimer = setInterval(nextSlide, AUTOPLAY_MS);
  }

  // Render the current slide into the stage. `dir` drives the slide-in anim.
  function paint(dir) {
    const t = TESTIMONIALS[ctx.testimonialSlide];
    const initials = t.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    const card = el('div', { class: 'tm-card tm-in-' + (dir === 'left' ? 'left' : 'right') }, [
      el('div', { class: 'tm-quote-mark' }, '“'),
      el('blockquote', { class: 'tm-quote' }, t.quote),
      el('div', { class: 'tm-stars', title: t.rating + ' out of 5' },
        Array.from({ length: 5 }, (_, i) =>
          el('span', { class: 'tm-star' + (i < t.rating ? ' on' : '') }, '★'))),
      el('div', { class: 'tm-author' }, [
        el('span', { class: 'tm-avatar' }, initials),
        el('div', { class: 'tm-author-meta' }, [
          el('span', { class: 'tm-name' }, t.name),
          el('span', { class: 'tm-role' }, t.role + ' · ' + t.company),
        ]),
      ]),
    ]);
    clear(stage);
    stage.appendChild(card);

    // Sync dot indicators.
    clear(dotsRow);
    TESTIMONIALS.forEach((_, i) => {
      dotsRow.appendChild(el('button', {
        class: 'tm-dot' + (i === ctx.testimonialSlide ? ' active' : ''),
        title: 'Go to testimonial ' + (i + 1),
        'aria-label': 'Go to testimonial ' + (i + 1),
        onclick: () => { go(i); restartTimer(); },
      }));
    });

    restartTimer();
  }

  const prevBtn = el('button', { class: 'tm-arrow tm-prev', title: 'Previous', 'aria-label': 'Previous testimonial',
    onclick: () => { prevSlide(); restartTimer(); } }, '‹');
  const nextBtn = el('button', { class: 'tm-arrow tm-next', title: 'Next', 'aria-label': 'Next testimonial',
    onclick: () => { nextSlide(); restartTimer(); } }, '›');

  const playBtn = el('button', { class: 'btn ghost sm tm-play' });
  function syncPlayBtn() { playBtn.textContent = ctx.testimonialPlaying ? '⏸ Pause' : '▶ Play'; }
  playBtn.addEventListener('click', () => {
    ctx.testimonialPlaying = !ctx.testimonialPlaying;
    syncPlayBtn();
    restartTimer();
  });
  syncPlayBtn();

  const carousel = el('div', { class: 'tm-carousel' }, [
    prevBtn,
    el('div', { class: 'tm-viewport' }, stage),
    nextBtn,
  ]);

  // Pause auto-play while the pointer is over the carousel; resume on leave
  // (only if the user hasn't explicitly paused).
  carousel.addEventListener('mouseenter', () => { if (ctx._testimonialTimer) { clearInterval(ctx._testimonialTimer); ctx._testimonialTimer = null; } });
  carousel.addEventListener('mouseleave', () => restartTimer());

  const wrap = el('div', { class: 'tm-wrap', tabindex: '0', 'aria-roledescription': 'carousel' }, [
    el('div', { class: 'tm-header' }, [
      el('h1', { class: 'tm-title' }, 'Trusted on the jobsite'),
      el('p', { class: 'tm-sub' }, 'What builders, PMs, and superintendents say about running their schedules on BuildFlow.'),
    ]),
    carousel,
    el('div', { class: 'tm-controls' }, [dotsRow, playBtn]),
  ]);

  // Keyboard nav when the carousel area has focus.
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); prevSlide(); restartTimer(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nextSlide(); restartTimer(); }
  });

  mount.appendChild(wrap);
  paint('right');
}
