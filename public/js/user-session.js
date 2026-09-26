/**
 * Shared stub user session + profile flyout + account/billing modal.
 * No auth backend — demo identity for the Spaces UI.
 */

export const DEMO_USER = {
  name: 'Vaibhav',
  email: 'vaibhav82711@gmail.com',
  plan: 'Free',
  initials: 'V',
};

const PLANS = [
  {
    id: 'week',
    name: 'Week Pass',
    price: '₹69',
    cadence: 'one-time',
    blurb: '15 caption mins · clean 1080p · no auto-renew',
  },
  {
    id: 'editor',
    name: 'Editor',
    price: '₹299',
    cadence: '/ month',
    blurb: '90 caption mins · 30 Auto Trim mins · 1080p 60fps',
  },
  {
    id: 'pro',
    name: 'Editor Pro',
    price: '₹469',
    cadence: '/ month',
    blurb: '4 hrs captions · 90 Auto Trim mins · 4K export',
  },
  {
    id: 'max',
    name: 'Editor MAX',
    price: '₹969',
    cadence: '/ month',
    blurb: '10 hrs captions · 220 Auto Trim mins · 4K 60fps',
  },
];

const ICONS = {
  account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.5"/><path d="M5 19.5c1.5-3.5 4-5 7-5s5.5 1.5 7 5"/></svg>',
  projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-10z"/></svg>',
  billing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/></svg>',
  signout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 7V5a2 2 0 0 1 2-2h7v18h-7a2 2 0 0 1-2-2v-2"/><path d="M15 12H4m0 0 3-3m-3 3 3 3"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l2.2 4.5 5 .7-3.6 3.5.9 5L12 14.8 7.5 16.7l.9-5L4.8 8.2l5-.7L12 3z"/></svg>',
  usage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21a9 9 0 1 1 9-9"/><path d="M12 12l5-3"/></svg>',
  devices: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="14" height="11" rx="1.5"/><path d="M7 19h10M17 9h4v8h-4"/></svg>',
  payments: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20"/></svg>',
  support: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12a8 8 0 0 1 16 0v5a2 2 0 0 1-2 2h-1v-6h3M4 13h3v6H6a2 2 0 0 1-2-2v-4z"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.7 2.2c-.8.5-1.2 1-1.2 2"/><circle cx="12" cy="17" r=".8" fill="currentColor"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 14l6-6 6 6"/></svg>',
  diamond: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.5 7H22l-5.5 4.5L18.5 22 12 17.5 5.5 22l2-8.5L2 9h6.5L12 2z"/></svg>',
};

let selectedPlanId = 'editor';
let activeTab = 'manage';
let mounted = false;

function $(sel, root = document) {
  return root.querySelector(sel);
}

function ensureDom() {
  if (document.getElementById('account-modal')) return;

  const flyoutHost = document.createElement('div');
  flyoutHost.id = 'user-flyout-root';
  flyoutHost.innerHTML = `
    <div class="user-flyout glass" id="user-flyout" hidden role="menu" aria-label="Account menu">
      <div class="flyout-bio">
        <div class="flyout-avatar">${DEMO_USER.initials}</div>
        <div>
          <strong class="flyout-name">${DEMO_USER.name}</strong>
          <span class="flyout-email">${DEMO_USER.email}</span>
          <span class="pill flyout-plan">${DEMO_USER.plan} plan</span>
        </div>
      </div>
      <button type="button" class="flyout-item" data-action="account" role="menuitem">${ICONS.account}<span>Account</span></button>
      <button type="button" class="flyout-item" data-action="projects" role="menuitem">${ICONS.projects}<span>Projects</span></button>
      <button type="button" class="flyout-item" data-action="billing" role="menuitem">${ICONS.billing}<span>Plan &amp; billing</span></button>
      <div class="flyout-sep"></div>
      <button type="button" class="flyout-item danger" data-action="signout" role="menuitem">${ICONS.signout}<span>Sign out</span></button>
    </div>
  `;
  document.body.appendChild(flyoutHost);

  const modal = document.createElement('div');
  modal.id = 'account-modal';
  modal.className = 'account-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="account-modal-backdrop" data-close-modal></div>
    <div class="account-modal-card glass" role="dialog" aria-modal="true" aria-labelledby="account-modal-title">
      <header class="account-modal-head">
        <div class="account-modal-user">
          <div class="flyout-avatar lg">${DEMO_USER.initials}</div>
          <div>
            <h2 id="account-modal-title">${DEMO_USER.name}</h2>
            <p>${DEMO_USER.email}</p>
          </div>
          <span class="pill">${DEMO_USER.plan}</span>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" data-close-modal aria-label="Close">✕</button>
      </header>
      <div class="account-modal-body">
        <aside class="account-nav" id="account-nav"></aside>
        <section class="account-content" id="account-content"></section>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function renderNav() {
  const nav = $('#account-nav');
  if (!nav) return;
  const items = [
    { id: 'manage', label: 'Manage plan', icon: ICONS.plan },
    { id: 'usage', label: 'Usage', icon: ICONS.usage },
    { id: 'devices', label: 'Devices / Sessions', icon: ICONS.devices },
    { id: 'payments', label: 'Payments', icon: ICONS.payments },
    { id: 'support', label: 'Support', icon: ICONS.support },
    { id: 'help', label: 'Help', icon: ICONS.help },
  ];
  nav.innerHTML = `
    ${items.map((i) => `
      <button type="button" class="account-nav-item ${activeTab === i.id ? 'active' : ''}" data-tab="${i.id}">
        ${i.icon}<span>${i.label}</span>
      </button>`).join('')}
    <div class="account-nav-foot">
      <button type="button" class="account-nav-item" data-action="projects">${ICONS.projects}<span>Projects</span></button>
      <button type="button" class="account-nav-item danger" data-action="signout">${ICONS.signout}<span>Log out</span></button>
    </div>
  `;
  nav.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.getAttribute('data-tab') || 'manage';
      renderNav();
      renderContent();
    });
  });
  nav.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleAction(btn.getAttribute('data-action')));
  });
}

function renderContent() {
  const root = $('#account-content');
  if (!root) return;

  if (activeTab === 'manage') {
    root.innerHTML = `
      <div class="current-plan-card">
        <div class="diamond">${ICONS.diamond}</div>
        <div>
          <span class="eyebrow">Current plan</span>
          <strong>${DEMO_USER.plan}</strong>
          <p>Caption Engine Free — upgrade anytime for more minutes and exports.</p>
        </div>
      </div>
      <h3 class="account-section-title">Available plans</h3>
      <div class="plan-pick-grid">
        ${PLANS.map((p) => `
          <button type="button" class="plan-pick ${selectedPlanId === p.id ? 'selected' : ''}" data-plan="${p.id}">
            <strong>${p.name}</strong>
            <span class="price">${p.price}<small>${p.cadence}</small></span>
            <span class="blurb">${p.blurb}</span>
          </button>`).join('')}
      </div>
      <button type="button" class="btn btn-primary btn-block" id="btn-upgrade">Upgrade →</button>
      <p class="account-footnote">Buying a different plan replaces this one immediately. Cancelling keeps access until the end of the paid period.</p>
    `;
    root.querySelectorAll('[data-plan]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedPlanId = btn.getAttribute('data-plan') || 'editor';
        renderContent();
      });
    });
    $('#btn-upgrade')?.addEventListener('click', () => {
      const plan = PLANS.find((p) => p.id === selectedPlanId);
      window.alert(`${plan?.name || 'Plan'} checkout is a demo on this Spaces build — wire Stripe/Razorpay when you go live.`);
    });
    return;
  }

  if (activeTab === 'usage') {
    root.innerHTML = `
      <h3 class="account-section-title">Usage this period</h3>
      <div class="usage-meters">
        <div class="usage-card">
          <span>Caption minutes left</span>
          <strong>0 <small>/ 0 min</small></strong>
          <div class="meter"><i style="width:0%"></i></div>
        </div>
        <div class="usage-card">
          <span>Auto Trim minutes left</span>
          <strong>0 <small>/ 0 min</small></strong>
          <div class="meter"><i style="width:0%"></i></div>
        </div>
      </div>
      <p class="account-footnote">Free plan minutes reset when you upgrade. Exports still work for finished projects on this device.</p>
    `;
    return;
  }

  if (activeTab === 'devices') {
    root.innerHTML = `
      <h3 class="account-section-title">Active sessions</h3>
      <div class="session-row">
        <div>${ICONS.devices}<div><strong>This browser</strong><span>Caption Engine · Hugging Face Spaces</span></div></div>
        <span class="pill">Current</span>
      </div>
      <p class="account-footnote">Sign out clears the local session stub. Server job temps still expire on their own TTL.</p>
    `;
    return;
  }

  if (activeTab === 'payments') {
    root.innerHTML = `
      <h3 class="account-section-title">Payments</h3>
      <div class="empty-soft">No receipts yet. Upgrades on Free plan will show here.</div>
    `;
    return;
  }

  if (activeTab === 'support') {
    root.innerHTML = `
      <h3 class="account-section-title">Support</h3>
      <p class="account-copy">Need help with captions, Auto Trim, or exports? Open an issue on the repo or email support from your Spaces settings.</p>
      <a class="btn btn-outline" href="https://github.com/rovsengine-ai/caption-engine/issues" target="_blank" rel="noopener">Open GitHub issues</a>
    `;
    return;
  }

  root.innerHTML = `
    <h3 class="account-section-title">Help</h3>
    <ul class="help-list">
      <li>Videos stay in memory until upload — never in localStorage or IndexedDB.</li>
      <li>Sarvam AI is primary; ElevenLabs Scribe is the automatic fallback.</li>
      <li>Restore any Auto Trim cut from the editor’s Auto Trim panel.</li>
    </ul>
  `;
}

function closeFlyout() {
  const fly = $('#user-flyout');
  if (fly) fly.hidden = true;
  document.querySelectorAll('[data-user-menu]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function positionFlyout(anchor) {
  const fly = $('#user-flyout');
  if (!fly || !anchor) return;
  const r = anchor.getBoundingClientRect();
  fly.hidden = false;
  const width = Math.max(280, fly.offsetWidth);
  let left = r.right - width;
  left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
  fly.style.left = `${left}px`;
  fly.style.top = `${r.bottom + 8}px`;
}

function toggleFlyout(anchor) {
  ensureDom();
  const fly = $('#user-flyout');
  if (!fly) return;
  if (!fly.hidden && fly.dataset.anchor === String(anchor)) {
    closeFlyout();
    return;
  }
  fly.dataset.anchor = String(anchor);
  positionFlyout(anchor);
  anchor.setAttribute('aria-expanded', 'true');
}

export function openAccountModal(tab = 'manage') {
  ensureDom();
  activeTab = tab;
  const modal = $('#account-modal');
  if (!modal) return;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  renderNav();
  renderContent();
  closeFlyout();
}

export function closeAccountModal() {
  const modal = $('#account-modal');
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
}

function handleAction(action) {
  closeFlyout();
  if (action === 'account') openAccountModal('manage');
  else if (action === 'billing') openAccountModal('manage');
  else if (action === 'projects') {
    closeAccountModal();
    if (typeof window.__ceNavigate === 'function') window.__ceNavigate('/app');
    else if (window.location.pathname !== '/app') window.location.href = '/app';
  } else if (action === 'signout') {
    closeAccountModal();
    window.alert('Signed out of the demo session. Reload to continue as Free plan.');
  }
}

function wireFlyoutActions() {
  $('#user-flyout')?.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleAction(btn.getAttribute('data-action')));
  });
}

/**
 * Enhance every `[data-user-menu]` trigger in the page with the shared flyout.
 */
export function mountUserChrome() {
  ensureDom();
  if (!mounted) {
    wireFlyoutActions();
    document.addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t.closest('[data-user-menu]') || t.closest('#user-flyout')) return;
      closeFlyout();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeFlyout();
        closeAccountModal();
      }
    });
    $('#account-modal')?.addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t.hasAttribute('data-close-modal') || t.closest('[data-close-modal]')) {
        closeAccountModal();
      }
    });
    mounted = true;
  }

  document.querySelectorAll('[data-user-menu]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFlyout(btn);
    });
  });
}

export function userMenuButtonHtml(extraClass = '') {
  return `
    <button type="button" class="user-menu-btn ${extraClass}" data-user-menu aria-label="Account menu">
      <span class="user-avatar">${DEMO_USER.initials}</span>
      <span class="user-chevron" aria-hidden="true">${ICONS.chevron}</span>
    </button>
  `;
}
