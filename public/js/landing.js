// Caption Engine — landing page interactivity.
// No video is ever touched here; this file only drives UI chrome
// (theme, tabs, reveal animations, a decorative phone mockup).

/**
 * In-memory only — never written to storage. Dark is the designed default
 * for this product; the toggle below is the supported way to switch.
 */
let currentTheme = 'dark';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(theme === 'light'));
  });
}

function initTheme() {
  applyTheme(currentTheme);
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(currentTheme === 'dark' ? 'light' : 'dark'));
  });
}

function initMobileNav() {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (!toggle || !links) return;
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  links.querySelectorAll('a').forEach((a) =>
    a.addEventListener('click', () => links.classList.remove('open')),
  );
}

function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (!id || id === '#') return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function initReveal() {
  const els = document.querySelectorAll('[data-reveal]');
  if (!('IntersectionObserver' in window) || els.length === 0) {
    els.forEach((el) => el.classList.add('in-view'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
  );
  els.forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i % 6, 5) * 60}ms`;
    io.observe(el);
  });
}

/** Simple two-state tab group: buttons with [data-tab-target], panels with matching [data-tab-panel]. */
function initTabGroup(root) {
  const buttons = root.querySelectorAll('[data-tab-target]');
  const panels = root.querySelectorAll('[data-tab-panel]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab-target');
      buttons.forEach((b) => b.classList.toggle('active', b === btn));
      panels.forEach((p) => p.classList.toggle('active', p.getAttribute('data-tab-panel') === target));
    });
  });
}

function initTabs() {
  document.querySelectorAll('[data-tab-group]').forEach(initTabGroup);
}

function initPricingToggle() {
  const group = document.querySelector('[data-billing-toggle]');
  if (!group) return;
  const buttons = group.querySelectorAll('.seg');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.toggle('active', b === btn));
      document.body.classList.toggle('yearly', btn.getAttribute('data-value') === 'yearly');
    });
  });
}

/** Decorative caption cycler inside the hero/languages phone mockups. */
const CAPTION_SAMPLES = [
  { text: 'यह वाला बहुत ज़्यादा वायरल होगा', hi: true },
  { text: 'ఇది చాలా వైరల్ అవుతుంది', hi: true },
  { text: 'இது நிச்சயம் வைரல் ஆகும்', hi: true },
  { text: 'this cut? absolutely sending it', hi: false },
  { text: 'ye edit dekh, next level hai', hi: false },
];

function initPhoneMockups() {
  const stages = document.querySelectorAll('[data-caption-cycle]');
  if (stages.length === 0) return;
  let idx = 0;
  function tick() {
    idx = (idx + 1) % CAPTION_SAMPLES.length;
    const sample = CAPTION_SAMPLES[idx];
    stages.forEach((el) => {
      el.style.opacity = '0';
      setTimeout(() => {
        el.textContent = sample.text;
        el.style.opacity = '1';
      }, 180);
    });
    const dots = document.querySelectorAll('[data-caption-dots] span');
    dots.forEach((d, i) => d.classList.toggle('active', i === idx % dots.length));
  }
  setInterval(tick, 2600);
}

function initNavShadow() {
  const nav = document.querySelector('.site-nav');
  if (!nav) return;
  const onScroll = () => {
    nav.style.boxShadow = window.scrollY > 8 ? 'var(--shadow-soft)' : 'none';
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

function init() {
  initTheme();
  initMobileNav();
  initSmoothScroll();
  initReveal();
  initTabs();
  initPricingToggle();
  initPhoneMockups();
  initNavShadow();
}

document.addEventListener('DOMContentLoaded', init);
