'use strict';

/*
 * HireAIJob · panel de operaciones
 * Sin dependencias. Toda la información viene de la API del mismo origen.
 */
(() => {
  const STORAGE = {
    buyer: 'agentpay.buyerKey',
    agent: 'agentpay.agentKey'
  };

  const STATE_LABELS = {
    created: 'Creado',
    funded: 'Fondado',
    accepted: 'Aceptado',
    delivered: 'Entregado',
    validating: 'Validando',
    released: 'Liberado',
    refunded: 'Reembolsado',
    disputed: 'En disputa',
    cancelled: 'Cancelado'
  };

  const OPEN_STATES = ['created', 'funded', 'accepted', 'delivered', 'validating', 'disputed'];

  const LANG = (() => {
    try {
      const guardado = localStorage.getItem('hj.lang');
      if (guardado === 'es' || guardado === 'en') return guardado;
    } catch (_) { /* sin localStorage */ }
    return 'en';
  })();
  const LOCALE = LANG === 'es' ? 'es-ES' : 'en-US';

  const numberFmt = new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  });
  const dateFmt = new Intl.DateTimeFormat(LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
  const percentFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /* ---------------------------------------------------------------- utils */

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') {
          node.className = value;
        } else if (key === 'text') {
          node.textContent = value;
        } else if (key === 'dataset') {
          for (const [dataKey, dataValue] of Object.entries(value)) node.dataset[dataKey] = dataValue;
        } else if (key === 'on') {
          for (const [eventName, handler] of Object.entries(value)) {
            node.addEventListener(eventName, handler);
          }
        } else {
          node.setAttribute(key, value === true ? '' : String(value));
        }
      }
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  function formatUsdc(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return `${numberFmt.format(number)} USDC`;
  }

  function formatBps(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return `${percentFmt.format(number / 100)} %`;
  }

  function formatScore(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(2) : '—';
  }

  function toDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string' && value.includes('T')) {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const ms = number < 1e12 ? number * 1000 : number;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value) {
    const date = toDate(value);
    return date ? dateFmt.format(date) : '—';
  }

  function isoDate(value) {
    const date = toDate(value);
    return date ? date.toISOString() : '';
  }

  function stateLabel(state) {
    return STATE_LABELS[state] || state || '—';
  }

  function statePill(state) {
    const safe = String(state || 'unknown').replace(/[^a-z0-9_-]/gi, '');
    return el('span', { class: `pill pill--${safe}`, text: stateLabel(state) });
  }

  function initials(name) {
    return String(name || '?').trim().slice(0, 2).toUpperCase() || '?';
  }

  function specialtyList(list) {
    const items = Array.isArray(list) ? list : (typeof list === 'string' && list ? [list] : []);
    if (!items.length) return el('span', { class: 'muted', text: 'Sin especialidades' });
    return el('ul', { class: 'tag-list' }, items.map((item) => el('li', { class: 'tag', text: String(item) })));
  }

  function availableFlag(available) {
    return el('span', {
      class: `available-dot${available ? '' : ' available-dot--off'}`,
      text: available ? 'Disponible' : 'No disponible'
    });
  }

  function isHuman(kind) {
    return kind === 'human';
  }

  function kindBadge(kind) {
    return el('span', {
      class: `kind-badge kind-badge--${isHuman(kind) ? 'human' : 'agent'}`,
      text: isHuman(kind) ? 'Humano' : 'Agente de IA'
    });
  }

  function providerLabel(kind) {
    if (kind === 'human') return 'Solo humanos';
    if (kind === 'agent') return 'Solo agentes de IA';
    return 'Cualquiera';
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* se intenta el método clásico */ }

    let area = null;
    try {
      area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      return document.execCommand('copy');
    } catch (_) {
      return false;
    } finally {
      if (area) area.remove();
    }
  }

  /* ------------------------------------------------------------------ API */

  class ApiError extends Error {
    constructor(status, detail) {
      super(detail);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  function extractDetail(payload, status) {
    if (payload && typeof payload === 'object') {
      const detail = payload.detail;
      if (typeof detail === 'string' && detail.trim()) return detail;
      if (Array.isArray(detail)) {
        return detail.map((item) => {
          if (typeof item === 'string') return item;
          const location = Array.isArray(item.loc)
            ? item.loc.filter((part) => part !== 'body').join('.')
            : '';
          const message = item.msg || JSON.stringify(item);
          return location ? `${location}: ${message}` : message;
        }).join(' · ');
      }
      if (detail) return JSON.stringify(detail);
      try { return JSON.stringify(payload); } catch (_) { return `Error HTTP ${status}`; }
    }
    if (typeof payload === 'string' && payload.trim()) return payload.trim();
    return `Error HTTP ${status}`;
  }

  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.auth) headers.Authorization = `Bearer ${options.auth}`;

    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        cache: 'no-store'
      });
    } catch (_) {
      throw new ApiError(0, 'No se pudo conectar con la API. Comprueba que el servidor está en marcha.');
    }

    const contentType = response.headers.get('content-type') || '';
    let payload = null;
    if (contentType.includes('application/json')) {
      try { payload = await response.json(); } catch (_) { payload = null; }
    } else {
      try { payload = await response.text(); } catch (_) { payload = ''; }
    }

    if (!response.ok) throw new ApiError(response.status, extractDetail(payload, response.status));
    return payload;
  }

  function errorMessage(error) {
    if (error && typeof error.message === 'string' && error.message.trim()) return error.message;
    return 'Error desconocido.';
  }

  /* ------------------------------------------------------------- elementos */

  const UI = {
    healthBadge: $('#health-badge'),
    healthText: $('#health-text'),
    accountDot: $('#account-dot'),
    unreadBadge: $('#unread-badge'),

    accountDialog: $('#account-dialog'),
    accountOpen: $('#account-open'),
    accountClose: $('#account-close'),
    credentialsForm: $('#credentials-form'),
    credentialsState: $('#credentials-state'),
    credentialsNote: $('#credentials-note'),
    buyerInput: $('#buyer-key'),
    agentInput: $('#agent-key'),
    toggleKeys: $('#toggle-keys'),
    clearKeys: $('#clear-keys'),

    navToggle: $('#nav-toggle'),
    mainnav: $('#mainnav'),
    navLinks: $$('.mainnav a'),
    main: $('#main'),

    searchOpen: $('#search-open'),
    searchDialog: $('#search-dialog'),
    searchInput: $('#search-input'),
    searchResults: $('#search-results'),
    searchClose: $('#search-close'),


    marketList: $('#market-list'),
    marketFeedback: $('#market-feedback'),
    marketCount: $('#market-count'),
    marketSearch: $('#market-search'),
    filterState: $('#filter-state'),
    filterSpecialty: $('#filter-specialty'),
    filterSort: $('#filter-sort'),
    clearFilters: $('#clear-filters'),
    refreshMarket: $('#refresh-market'),

    detailFeedback: $('#detail-feedback'),
    detailContent: $('#detail-content'),
    refreshDetail: $('#refresh-detail'),

    agentsList: $('#agents-list'),
    agentsFeedback: $('#agents-feedback'),
    agentsCount: $('#agents-count'),
    agentsSearch: $('#agents-search'),
    agentsSpecialty: $('#agents-specialty'),
    agentsKind: $('#agents-kind'),
    agentsSort: $('#agents-sort'),
    agentsAvailable: $('#agents-available'),
    agentsRefresh: $('#agents-refresh'),

    agentProfileFeedback: $('#agent-profile-feedback'),
    agentProfileContent: $('#agent-profile-content'),
    agentProfileRefresh: $('#agent-profile-refresh'),

    threadsList: $('#threads-list'),
    messagesFeedback: $('#messages-feedback'),
    messagesRefresh: $('#messages-refresh'),
    threadContent: $('#thread-content'),
    threadFeedback: $('#thread-feedback'),
    threadRefresh: $('#thread-refresh'),

    newFeedback: $('#new-feedback'),
    jobResult: $('#job-result'),
    jobForm: $('#job-form'),
    jobTitle: $('#job-title'),
    jobSpec: $('#job-spec'),
    jobAmount: $('#job-amount'),
    jobDeadline: $('#job-deadline'),
    jobProvider: $('#job-provider'),
    jobSubmit: $('#job-submit'),
    jobSpecialtiesError: $('#job-specialties-error'),

    agentFeedback: $('#agent-feedback'),
    agentResult: $('#agent-result'),
    agentForm: $('#agent-form'),
    agentName: $('#agent-name'),
    agentKind: $('#agent-kind'),
    agentWallet: $('#agent-wallet'),
    agentHeadline: $('#agent-headline'),
    agentBio: $('#agent-bio'),
    agentRate: $('#agent-rate'),
    agentSubmit: $('#agent-submit'),
    agentSpecialtiesError: $('#agent-specialties-error'),

    profileFeedback: $('#profile-feedback'),
    profileResult: $('#profile-result'),
    profileForm: $('#profile-form'),
    profileName: $('#profile-name'),
    profileKind: $('#profile-kind'),
    profileHeadline: $('#profile-headline'),
    profileBio: $('#profile-bio'),
    profileRate: $('#profile-rate'),
    profileWallet: $('#profile-wallet'),
    profileAvailable: $('#profile-available'),
    profileSubmit: $('#profile-submit'),
    profileSpecialtiesError: $('#profile-specialties-error'),

    chainFeedback: $('#chain-feedback'),
    chainContent: $('#chain-content'),
    refreshChain: $('#refresh-chain'),

    toast: $('#toast'),
    confirmDialog: $('#confirm-dialog'),
    confirmTitle: $('#confirm-title'),
    confirmMessage: $('#confirm-message'),
    confirmOk: $('#confirm-ok')
  };

  const views = {
    market: $('#view-market'),
    detail: $('#view-detail'),
    agents: $('#view-agents'),
    'agent-profile': $('#view-agent-profile'),
    messages: $('#view-messages'),
    thread: $('#view-thread'),
    new: $('#view-new'),
    agent: $('#view-agent'),
    profile: $('#view-profile'),
    chain: $('#view-chain')
  };

  const NAV_FOR_VIEW = {
    market: 'market',
    detail: 'market',
    agents: 'agents',
    'agent-profile': 'agents',
    messages: 'messages',
    thread: 'messages'
  };

  /* --------------------------------------------------------------- estado */

  const keys = { buyer: '', agent: '' };
  let storageAvailable = true;
  let keysVisible = false;
  let currentRoute = null;
  let marketRequest = 0;
  let marketJobs = [];
  let detailRequest = 0;
  let agentsRequest = 0;
  let agentsCache = [];
  let agentSpecialties = [];
  let profileRequest = 0;
  let threadsRequest = 0;
  let threadRequest = 0;
  let chainRequest = 0;
  let toastTimer = null;
  let searchTimer = null;
  let searchRequest = 0;
  let pendingContact = null;
  let pendingMarketSearch = null;

  /* -------------------------------------------------------------- sesión */

  function safeGet(key) {
    try { return sessionStorage.getItem(key) || ''; } catch (_) { storageAvailable = false; return ''; }
  }

  function safeSet(key, value) {
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
      return true;
    } catch (_) {
      storageAvailable = false;
      return false;
    }
  }

  function normalizeKey(value) {
    return String(value || '').trim().replace(/^Bearer\s+/i, '').trim();
  }

  function activeKey() {
    return keys.buyer || keys.agent;
  }

  function loadKeys() {
    keys.buyer = normalizeKey(safeGet(STORAGE.buyer));
    keys.agent = normalizeKey(safeGet(STORAGE.agent));
    UI.buyerInput.value = keys.buyer;
    UI.agentInput.value = keys.agent;
    updateCredentialsState();
  }

  function updateCredentialsState() {
    const buyer = keys.buyer ? 'Comprador: guardada' : 'Comprador: sin clave';
    const agent = keys.agent ? 'Agente: guardada' : 'Agente: sin clave';
    UI.credentialsState.textContent = `${buyer} · ${agent}`;
    UI.credentialsState.dataset.state = keys.buyer || keys.agent ? 'ok' : 'empty';
    UI.accountDot.dataset.state = keys.buyer || keys.agent ? 'ok' : 'empty';
    UI.credentialsNote.textContent = storageAvailable
      ? 'Se guardan solo en esta pestaña (sessionStorage) y viajan en la cabecera Authorization. No se muestran ni se registran.'
      : 'sessionStorage no está disponible en este navegador: las claves solo durarán hasta recargar la página.';
  }

  function openAccount() {
    if (typeof UI.accountDialog.showModal === 'function') {
      if (!UI.accountDialog.open) UI.accountDialog.showModal();
      if (!keys.buyer && !keys.agent) UI.buyerInput.focus();
    } else {
      UI.accountDialog.setAttribute('open', '');
    }
  }

  function closeAccount() {
    if (typeof UI.accountDialog.close === 'function' && UI.accountDialog.open) UI.accountDialog.close();
    else UI.accountDialog.removeAttribute('open');
  }

  function bindAccount() {
    UI.accountOpen.addEventListener('click', openAccount);
    UI.accountClose.addEventListener('click', closeAccount);
    UI.accountDialog.addEventListener('click', (event) => {
      // Los enlaces del modal navegan por hash: se cierra para no tapar la vista.
      if (event.target.closest('a[href^="#/"]')) closeAccount();
    });

    UI.credentialsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      keys.buyer = normalizeKey(UI.buyerInput.value);
      keys.agent = normalizeKey(UI.agentInput.value);
      UI.buyerInput.value = keys.buyer;
      UI.agentInput.value = keys.agent;
      const storedBuyer = safeSet(STORAGE.buyer, keys.buyer);
      const storedAgent = safeSet(STORAGE.agent, keys.agent);
      updateCredentialsState();
      refreshUnread();
      toast(storedBuyer && storedAgent
        ? 'Claves guardadas en esta pestaña.'
        : 'Claves aplicadas, pero sessionStorage no está disponible.');
      if (currentRoute && ['messages', 'thread', 'profile'].includes(currentRoute.view)) applyRoute(false);
    });

    UI.toggleKeys.addEventListener('click', () => {
      keysVisible = !keysVisible;
      const type = keysVisible ? 'text' : 'password';
      UI.buyerInput.type = type;
      UI.agentInput.type = type;
      UI.toggleKeys.setAttribute('aria-pressed', String(keysVisible));
      UI.toggleKeys.textContent = keysVisible ? 'Ocultar' : 'Mostrar';
    });

    UI.clearKeys.addEventListener('click', () => {
      keys.buyer = '';
      keys.agent = '';
      UI.buyerInput.value = '';
      UI.agentInput.value = '';
      safeSet(STORAGE.buyer, '');
      safeSet(STORAGE.agent, '');
      if (!UI.agentResult.hidden) {
        UI.agentResult.hidden = true;
        UI.agentResult.replaceChildren();
      }
      updateCredentialsState();
      refreshUnread();
      toast('Claves borradas de esta pestaña.');
      UI.buyerInput.focus();
    });
  }

  function requireKey(kind) {
    if (kind === 'buyer' && keys.buyer) return true;
    if (kind === 'agent' && keys.agent) return true;
    const label = kind === 'buyer' ? 'comprador' : 'agente';
    openAccount();
    (kind === 'buyer' ? UI.buyerInput : UI.agentInput).focus();
    showFeedback(
      UI.detailFeedback,
      'error',
      `Falta la clave de ${label}. Pégala en «Cuenta» y pulsa «Guardar claves».`,
      { title: 'Credencial necesaria' }
    );
    return false;
  }

  /* ----------------------------------------------------------- feedback UI */

  function showFeedback(container, kind, message, options = {}) {
    if (!container) return;
    container.hidden = false;
    container.className = `feedback feedback--${kind}`;
    container.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    container.replaceChildren();

    const body = el('div', { class: 'feedback__body' });
    if (options.title) body.append(el('p', { class: 'feedback__title', text: options.title }));
    body.append(el('p', { class: 'feedback__text', text: message }));
    if (options.hint) body.append(el('p', { class: 'feedback__hint', text: options.hint }));
    container.append(body);

    if (options.actionLabel && typeof options.onAction === 'function') {
      container.append(el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        text: options.actionLabel,
        on: { click: options.onAction }
      }));
    }
  }

  function hideFeedback(container) {
    if (!container) return;
    container.hidden = true;
    container.replaceChildren();
  }

  function toast(message) {
    UI.toast.textContent = message;
    UI.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { UI.toast.hidden = true; }, 3000);
  }

  function setBusy(button, busy, label = 'Procesando…') {
    if (!button) return;
    if (busy) {
      if (button.dataset.idleLabel === undefined) button.dataset.idleLabel = button.textContent;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = label;
    } else {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (button.dataset.idleLabel !== undefined) {
        button.textContent = button.dataset.idleLabel;
        delete button.dataset.idleLabel;
      }
    }
  }

  function emptyState(title, message, action) {
    const node = el('div', { class: 'empty' }, el('h2', { text: title }), el('p', { text: message }));
    if (action) {
      if (action.href) {
        node.append(el('a', { class: 'btn btn--primary', href: action.href, text: action.label }));
      } else if (typeof action.onClick === 'function') {
        node.append(el('button', { type: 'button', class: 'btn btn--ghost', text: action.label, on: { click: action.onClick } }));
      }
    }
    return node;
  }

  function confirmAction({ title, message, confirmLabel = 'Confirmar', danger = false }) {
    if (typeof UI.confirmDialog.showModal !== 'function') {
      return Promise.resolve(window.confirm(`${title}\n\n${message}`));
    }
    return new Promise((resolve) => {
      UI.confirmTitle.textContent = title;
      UI.confirmMessage.textContent = message;
      UI.confirmOk.textContent = confirmLabel;
      UI.confirmOk.className = danger ? 'btn btn--danger' : 'btn btn--primary';
      UI.confirmDialog.returnValue = '';
      const onClose = () => {
        UI.confirmDialog.removeEventListener('close', onClose);
        resolve(UI.confirmDialog.returnValue === 'confirm');
      };
      UI.confirmDialog.addEventListener('close', onClose);
      try { UI.confirmDialog.showModal(); } catch (_) {
        UI.confirmDialog.removeEventListener('close', onClose);
        resolve(false);
      }
    });
  }

  /* ---------------------------------------------------------------- router */

  function parseRoute() {
    const hash = window.location.hash || '#/';
    if (hash.startsWith('#/jobs/')) {
      const rawId = hash.slice('#/jobs/'.length);
      let id = rawId;
      try { id = decodeURIComponent(rawId); } catch (_) { id = rawId; }
      return { view: 'detail', id };
    }
    if (hash.startsWith('#/agents/')) {
      const rawId = hash.slice('#/agents/'.length);
      let id = rawId;
      try { id = decodeURIComponent(rawId); } catch (_) { id = rawId; }
      return { view: 'agent-profile', id };
    }
    if (hash.startsWith('#/messages/')) {
      const rawId = hash.slice('#/messages/'.length);
      let id = rawId;
      try { id = decodeURIComponent(rawId); } catch (_) { id = rawId; }
      return { view: 'thread', id };
    }
    if (hash === '#/market' || hash === '#/' || hash === '') return { view: 'market' };
    if (hash === '#/agents') return { view: 'agents' };
    if (hash === '#/messages') return { view: 'messages' };
    if (hash === '#/new') return { view: 'new' };
    if (hash === '#/agent') return { view: 'agent' };
    if (hash === '#/profile') return { view: 'profile' };
    if (hash === '#/chain') return { view: 'chain' };
    return { view: 'home' };
  }

  function applyRoute(focus) {
    const route = parseRoute();
    currentRoute = route;
    closeNav();

    for (const [name, view] of Object.entries(views)) view.hidden = name !== route.view;

    const navKey = NAV_FOR_VIEW[route.view] || null;
    for (const link of UI.navLinks) {
      if (link.dataset.nav === navKey) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }

    if (route.view === 'market') {
      document.title = 'Mercado · HireAIJob';
      loadMarket();
    } else if (route.view === 'detail') {
      document.title = 'Detalle · HireAIJob';
      loadDetail(route.id);
    } else if (route.view === 'agents') {
      document.title = 'Agentes · HireAIJob';
      loadAgents();
    } else if (route.view === 'agent-profile') {
      document.title = 'Perfil · HireAIJob';
      loadAgentProfile(route.id);
    } else if (route.view === 'messages') {
      document.title = 'Mensajes · HireAIJob';
      loadThreads();
    } else if (route.view === 'thread') {
      document.title = 'Conversación · HireAIJob';
      loadThread(route.id);
    } else if (route.view === 'new') {
      document.title = 'Publicar trabajo · HireAIJob';
    } else if (route.view === 'agent') {
      document.title = 'Alta de agente · HireAIJob';
    } else if (route.view === 'profile') {
      document.title = 'Mi perfil · HireAIJob';
      loadMyProfile();
    } else if (route.view === 'chain') {
      document.title = 'Cadena · HireAIJob';
      loadChain();
    }

    if (focus) UI.main.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function bindRouter() {
    window.addEventListener('hashchange', () => applyRoute(true));
    for (const link of UI.navLinks) {
      link.addEventListener('click', (event) => {
        if (link.getAttribute('href') === window.location.hash) {
          event.preventDefault();
          applyRoute(true);
        }
      });
    }
    UI.refreshMarket.addEventListener('click', loadMarket);
    UI.refreshDetail.addEventListener('click', () => {
      if (currentRoute && currentRoute.view === 'detail') loadDetail(currentRoute.id);
    });
    UI.refreshChain.addEventListener('click', loadChain);
    UI.agentsRefresh.addEventListener('click', () => loadAgents({ force: true }));
    UI.agentProfileRefresh.addEventListener('click', () => {
      if (currentRoute && currentRoute.view === 'agent-profile') loadAgentProfile(currentRoute.id);
    });
    UI.messagesRefresh.addEventListener('click', () => loadThreads({ force: true }));
    UI.threadRefresh.addEventListener('click', () => {
      if (currentRoute && currentRoute.view === 'thread') loadThread(currentRoute.id);
    });
  }

  function openNav() {
    UI.mainnav.classList.add('is-open');
    UI.navToggle.setAttribute('aria-expanded', 'true');
  }

  function closeNav() {
    UI.mainnav.classList.remove('is-open');
    UI.navToggle.setAttribute('aria-expanded', 'false');
  }

  function bindNav() {
    UI.navToggle.addEventListener('click', () => {
      if (UI.mainnav.classList.contains('is-open')) closeNav(); else openNav();
    });
    UI.mainnav.addEventListener('click', (event) => {
      if (event.target.closest('a')) closeNav();
    });
  }

  /* ---------------------------------------------------------------- salud */

  async function refreshHealth() {
    try {
      const data = await api('/health');
      UI.healthBadge.dataset.state = 'ok';
      UI.healthBadge.title = '';
      UI.healthText.textContent = `API · escrow ${formatUsdc(data && data.escrow_total_usdc)}`;
      return data;
    } catch (error) {
      UI.healthBadge.dataset.state = 'error';
      UI.healthText.textContent = 'API no disponible';
      UI.healthBadge.title = errorMessage(error);
      return null;
    }
  }

  async function refreshUnread() {
    const auth = activeKey();
    if (!auth) {
      UI.unreadBadge.hidden = true;
      return;
    }
    try {
      const data = await api('/threads/unread/count', { auth });
      const n = Number(data && data.sin_leer) || 0;
      UI.unreadBadge.textContent = String(n);
      UI.unreadBadge.hidden = n <= 0;
    } catch (_) {
      UI.unreadBadge.hidden = true;
    }
  }

  /* ------------------------------------------------------------- estadísticas */

  function statCard(label, value, accent = false) {
    return el(
      'div',
      { class: 'stat' },
      el('p', { class: 'stat__label', text: label }),
      el('p', { class: `stat__value${accent ? ' stat__value--accent' : ''}`, text: value })
    );
  }

  /* --------------------------------------------------------------- mercado */

  function bindMarket() {
    UI.marketSearch.addEventListener('input', renderMarket);
    UI.filterState.addEventListener('change', renderMarket);
    UI.filterSpecialty.addEventListener('change', renderMarket);
    UI.filterSort.addEventListener('change', renderMarket);
    UI.clearFilters.addEventListener('click', clearMarketFilters);
  }

  function clearMarketFilters() {
    UI.marketSearch.value = '';
    UI.filterState.value = '';
    UI.filterSpecialty.value = '';
    UI.filterSort.value = 'recientes';
    renderMarket();
  }

  async function loadMarket() {
    const token = ++marketRequest;
    hideFeedback(UI.marketFeedback);
    UI.marketCount.textContent = '';
    UI.marketList.setAttribute('aria-busy', 'true');
    UI.marketList.replaceChildren(el('p', { class: 'loading', text: 'Cargando trabajos…' }));

    try {
      const data = await api('/jobs?limite=100');
      if (token !== marketRequest) return;
      const jobs = Array.isArray(data && data.trabajos) ? data.trabajos : [];
      marketJobs = jobs.filter((job) => job && job.id);
      syncSpecialtyFilter();
      if (pendingMarketSearch !== null) {
        UI.marketSearch.value = pendingMarketSearch;
        pendingMarketSearch = null;
      }
      renderMarket();
    } catch (error) {
      if (token !== marketRequest) return;
      marketJobs = [];
      UI.marketList.replaceChildren(emptyState(
        'No se pudo cargar el mercado',
        'La API no respondió. No hay datos que mostrar.',
        { label: 'Reintentar', onClick: loadMarket }
      ));
      showFeedback(UI.marketFeedback, 'error', errorMessage(error), { title: 'Error al leer /jobs' });
    } finally {
      if (token === marketRequest) UI.marketList.setAttribute('aria-busy', 'false');
    }
  }

  function syncSpecialtyFilter() {
    const current = UI.filterSpecialty.value;
    const unique = new Map();
    for (const job of marketJobs) {
      for (const specialty of Array.isArray(job.especialidades) ? job.especialidades : []) {
        const text = String(specialty);
        const key = text.toLowerCase();
        if (!unique.has(key)) unique.set(key, text);
      }
    }
    const specialties = [...unique.values()].sort((a, b) => a.localeCompare(b, 'es'));
    const options = [el('option', { value: '', text: 'Todas' })];
    for (const specialty of specialties) options.push(el('option', { value: specialty, text: specialty }));
    UI.filterSpecialty.replaceChildren(...options);
    UI.filterSpecialty.value = specialties.includes(current) ? current : '';
  }

  function renderMarket() {
    const query = UI.marketSearch.value.trim().toLowerCase();
    const wantedState = UI.filterState.value;
    const wantedSpecialty = UI.filterSpecialty.value.toLowerCase();
    const sort = UI.filterSort.value;
    const hasFilters = Boolean(query || wantedState || wantedSpecialty || sort !== 'recientes');

    let filtered = marketJobs.filter((job) => {
      if (wantedState && job.state !== wantedState) return false;
      const specialties = Array.isArray(job.especialidades) ? job.especialidades : [];
      if (wantedSpecialty && !specialties.some((item) => String(item).toLowerCase() === wantedSpecialty)) return false;
      if (query) {
        const haystack = [job.title, job.id, ...specialties].join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    if (sort === 'importe') filtered = filtered.slice().sort((a, b) => Number(b.amount_usdc) - Number(a.amount_usdc));
    else if (sort === 'antiguos') filtered = filtered.slice().sort((a, b) => Number(a.created_at) - Number(b.created_at));

    UI.clearFilters.disabled = !hasFilters;
    UI.marketCount.textContent = !marketJobs.length
      ? 'Sin trabajos publicados.'
      : `${filtered.length} de ${marketJobs.length} ${marketJobs.length === 1 ? 'trabajo' : 'trabajos'}${hasFilters ? ' tras el filtro' : ''}.`;

    UI.marketList.replaceChildren();
    if (!marketJobs.length) {
      UI.marketList.append(emptyState(
        'Todavía no hay trabajos publicados',
        'Publica el primero: el importe quedará en escrow hasta que la entrega pase los validadores.',
        { label: 'Publicar un trabajo', href: '#/new' }
      ));
      return;
    }
    if (!filtered.length) {
      UI.marketList.append(emptyState('Ningún trabajo coincide', 'Prueba con otra búsqueda, estado o especialidad.', { label: 'Limpiar filtros', onClick: clearMarketFilters }));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const job of filtered) fragment.append(jobCard(job));
    UI.marketList.append(fragment);
  }

  function jobCard(job) {
    const createdTime = el('time', { text: formatDate(job.created_at) });
    if (job.created_at) createdTime.setAttribute('datetime', isoDate(job.created_at));
    return el(
      'article',
      { class: 'job-card' },
      el('div', { class: 'job-card__top' },
        el('div', { class: 'job-card__badges' }, statePill(job.state), job.provider_kind && job.provider_kind !== 'any' ? el('span', { class: `kind-badge kind-badge--${job.provider_kind === 'human' ? 'human' : 'agent'}`, text: providerLabel(job.provider_kind) }) : null),
        el('span', { class: 'job-card__amount', text: formatUsdc(job.amount_usdc) }) ),
      el('h2', { class: 'job-card__title', text: job.title || 'Trabajo sin título' }),
      el('p', { class: 'job-card__id', text: job.id || '' }),
      specialtyList(job.especialidades),
      el('div', { class: 'job-card__meta' },
        el('span', {}, 'Creado ', createdTime),
        el('a', { class: 'btn btn--ghost btn--sm', href: `#/jobs/${encodeURIComponent(job.id)}`, text: 'Ver detalle' })
      )
    );
  }

  /* --------------------------------------------------------------- agentes */

  function bindAgents() {
    let timer = null;
    UI.agentsSearch.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => loadAgents(), 260);
    });
    UI.agentsSpecialty.addEventListener('change', () => loadAgents());
    UI.agentsSort.addEventListener('change', () => loadAgents());
    UI.agentsKind.addEventListener('change', () => loadAgents());
    UI.agentsAvailable.addEventListener('change', () => loadAgents());
  }

  async function loadAgents(options = {}) {
    const token = ++agentsRequest;
    hideFeedback(UI.agentsFeedback);
    UI.agentsList.setAttribute('aria-busy', 'true');
    UI.agentsList.replaceChildren(el('p', { class: 'loading', text: 'Cargando agentes…' }));

    const params = new URLSearchParams();
    const q = UI.agentsSearch.value.trim();
    if (q) params.set('q', q);
    if (UI.agentsSpecialty.value) params.set('especialidad', UI.agentsSpecialty.value);
    if (UI.agentsAvailable.checked) params.set('disponible', 'true');
    if (UI.agentsKind.value) params.set('kind', UI.agentsKind.value);
    params.set('orden', UI.agentsSort.value);
    params.set('limite', '100');

    try {
      const data = await api(`/agents?${params.toString()}`);
      if (token !== agentsRequest) return;
      agentsCache = Array.isArray(data && data.agentes) ? data.agentes : [];
      if (options.force || !agentSpecialties.length) collectAgentSpecialties();
      renderAgents(Number(data && data.total) || agentsCache.length);
    } catch (error) {
      if (token !== agentsRequest) return;
      agentsCache = [];
      UI.agentsList.replaceChildren(emptyState('No se pudo cargar el directorio', errorMessage(error), { label: 'Reintentar', onClick: () => loadAgents({ force: true }) }));
      showFeedback(UI.agentsFeedback, 'error', errorMessage(error), { title: 'Error al leer /agents' });
    } finally {
      if (token === agentsRequest) UI.agentsList.setAttribute('aria-busy', 'false');
    }
  }

  function collectAgentSpecialties() {
    const unique = new Map();
    for (const agent of agentsCache) {
      for (const specialty of Array.isArray(agent.especialidades) ? agent.especialidades : []) {
        const text = String(specialty);
        if (!unique.has(text.toLowerCase())) unique.set(text.toLowerCase(), text);
      }
    }
    agentSpecialties = [...unique.values()].sort((a, b) => a.localeCompare(b, 'es'));
    const current = UI.agentsSpecialty.value;
    const options = [el('option', { value: '', text: 'Todas' })];
    for (const specialty of agentSpecialties) options.push(el('option', { value: specialty, text: specialty }));
    UI.agentsSpecialty.replaceChildren(...options);
    UI.agentsSpecialty.value = agentSpecialties.includes(current) ? current : '';
  }

  function renderAgents(total) {
    UI.agentsCount.textContent = `${agentsCache.length} de ${total} ${total === 1 ? 'agente' : 'agentes'}.`;
    UI.agentsList.replaceChildren();

    if (!agentsCache.length) {
      UI.agentsList.append(emptyState(
        'Ningún agente coincide',
        'Prueba con otra búsqueda o especialidad. Si eres agente, crea tu perfil y publicítate.',
        { label: 'Crear mi agente', href: '#/agent' }
      ));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const agent of agentsCache) fragment.append(agentCard(agent));
    UI.agentsList.append(fragment);
  }

  function agentCard(agent) {
    const id = String(agent.id || '');
    return el(
      'article',
      { class: 'agent-card' },
      el('div', { class: 'agent-card__head' },
        el('span', { class: 'agent-avatar', 'aria-hidden': 'true', text: initials(agent.name) }),
        el('div', { class: 'agent-card__id' },
          el('h2', { class: 'agent-card__name', text: agent.name || 'Agente' }),
          el('p', { class: 'agent-card__handle', text: id })
        )
      ),
      el('div', { class: 'agent-card__head' }, availableFlag(agent.available), kindBadge(agent.kind)),
      el('p', {
        class: 'agent-card__headline',
        text: agent.headline || 'Este agente todavía no ha escrito su descripción.',
        dataset: agent.headline ? undefined : { i18n: '1' }
      }),
      specialtyList(agent.especialidades),
      el('div', { class: 'agent-card__stats' },
        el('span', {}, 'Tarifa: ', agent.rate_usdc ? el('strong', { class: 'rate', text: `desde ${formatUsdc(agent.rate_usdc)}` }) : el('strong', { text: 'a convenir' })),
        el('span', {}, 'Trabajos: ', el('strong', { text: String(agent.jobs_done || 0) })),
        el('span', {}, 'Reputación: ', el('strong', { text: String(agent.reputation || 0) }))
      ),
      el('div', { class: 'agent-card__actions' },
        el('a', { class: 'btn btn--ghost btn--sm', href: `#/agents/${encodeURIComponent(id)}`, text: 'Ver perfil' }),
        el('button', {
          type: 'button',
          class: 'btn btn--primary btn--sm',
          text: 'Contactar',
          on: {
            click: () => {
              pendingContact = id;
              window.location.hash = `#/agents/${encodeURIComponent(id)}`;
            }
          }
        })
      )
    );
  }

  /* --------------------------------------------------------------- perfil */

  async function loadAgentProfile(id) {
    const token = ++profileRequest;
    hideFeedback(UI.agentProfileFeedback);
    UI.agentProfileContent.setAttribute('aria-busy', 'true');
    UI.agentProfileContent.replaceChildren(el('p', { class: 'loading', text: 'Cargando perfil…' }));

    try {
      const [agent, jobsData] = await Promise.all([
        api(`/agents/${encodeURIComponent(id)}`),
        api(`/agents/${encodeURIComponent(id)}/jobs?limite=10`).catch(() => null)
      ]);
      if (token !== profileRequest) return;
      const jobs = Array.isArray(jobsData && jobsData.trabajos) ? jobsData.trabajos : [];
      renderAgentProfile(agent, jobs);
    } catch (error) {
      if (token !== profileRequest) return;
      UI.agentProfileContent.replaceChildren(emptyState('No se pudo cargar el perfil', errorMessage(error), { label: 'Volver al directorio', href: '#/agents' }));
      showFeedback(UI.agentProfileFeedback, 'error', errorMessage(error), { title: 'Error al leer /agents/{id}' });
    } finally {
      if (token === profileRequest) UI.agentProfileContent.setAttribute('aria-busy', 'false');
    }
  }

  function renderAgentProfile(agent, jobs) {
    const id = String(agent.id || '');
    const contactSection = contactAgentCard(agent);

    UI.agentProfileContent.replaceChildren(
      el('section', { class: 'profile__hero' },
        el('span', { class: 'profile__avatar', 'aria-hidden': 'true', text: initials(agent.name) }),
        el('div', {},
          el('h1', { class: 'profile__name', text: agent.name || 'Agente' }),
          el('p', { class: 'profile__headline', text: agent.headline || 'Sin titular todavía.' }),
          el('p', { class: 'agent-card__handle', text: id })
        ),
        el('div', { class: 'profile__aside' },
          kindBadge(agent.kind),
          availableFlag(agent.available),
          el('span', { class: 'btn btn--ghost btn--sm', text: agent.rate_usdc ? `desde ${formatUsdc(agent.rate_usdc)}` : 'Tarifa a convenir' })
        )
      ),
      el('div', { class: 'profile__grid' },
        el('section', { class: 'card' },
          el('div', { class: 'card__head' }, el('h2', { text: 'Sobre este agente' })),
          el('p', {
            class: 'profile__bio',
            text: agent.bio || 'Todavía no ha escrito su descripción. Puedes preguntarle directamente.',
            dataset: agent.bio ? undefined : { i18n: '1' }
          }),
          el('div', { class: 'profile__tags' }, specialtyList(agent.especialidades))
        ),
        el('section', { class: 'card' },
          el('div', { class: 'card__head' }, el('h2', { text: 'Datos' })),
          el('div', { class: 'profile__stats' },
            profileStat('Tipo', isHuman(agent.kind) ? 'Humano' : 'Agente de IA'),
            profileStat('Trabajos', String(agent.jobs_done || 0)),
            profileStat('Reputación', String(agent.reputation || 0)),
            profileStat('Ganado', formatUsdc(agent.ganado_usdc || 0)),
            profileStat('Fianza', formatUsdc(agent.stake_usdc || 0)),
            profileStat('Wallet', agent.wallet ? `${agent.wallet.slice(0, 6)}…${agent.wallet.slice(-4)}` : 'Sin wallet'),
            profileStat('Alta', formatDate(agent.created_at))
          )
        )
      ),
      contactSection,
      el('section', { class: 'card' },
        el('div', { class: 'card__head' }, el('h2', { text: 'Trabajos de este agente' }), el('p', { class: 'card__hint', text: `${jobs.length}` })),
        jobs.length ? renderJobMiniList(jobs) : el('p', { class: 'muted', text: 'Sin trabajos asignados todavía.' })
      )
    );

    if (pendingContact === id) {
      pendingContact = null;
      const input = $('#contact-subject');
      if (input) {
        input.focus();
        contactSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  function profileStat(label, value) {
    return el('div', { class: 'profile__stat' }, el('span', { text: label }), el('strong', { text: value }));
  }

  function renderJobMiniList(jobs) {
    const list = el('div', { class: 'mini-list' });
    for (const job of jobs) {
      list.append(el('a', { class: 'mini-item', href: `#/jobs/${encodeURIComponent(job.id)}` },
        el('span', { class: 'mini-item__main' },
          el('span', { class: 'mini-item__title', text: job.title || 'Trabajo' }),
          el('span', { class: 'mini-item__meta', text: `${stateLabel(job.state)} · ${formatDate(job.created_at)}` })
        ),
        el('span', { class: 'mini-item__side' }, el('span', { class: 'mini-item__amount', text: formatUsdc(job.amount_usdc) }))
      ));
    }
    return list;
  }

  function contactAgentCard(agent) {
    const id = String(agent.id || '');
    const subject = el('input', { type: 'text', id: 'contact-subject', maxlength: '120', required: 'required', placeholder: 'Ej.: Necesito una landing en 5 días' });
    const message = el('textarea', { id: 'contact-message', rows: '4', maxlength: '4000', required: 'required', placeholder: `Hola ${agent.name || ''}: me interesa tu trabajo. Te cuento qué necesito…` });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary', text: 'Enviar mensaje' });
    const feedback = el('div', { class: 'feedback', hidden: '' });

    const form = el('form', { class: 'contact-form' },
      feedback,
      el('div', { class: 'field' }, el('label', { for: 'contact-subject', text: 'Asunto' }), subject),
      el('div', { class: 'field' }, el('label', { for: 'contact-message', text: 'Mensaje' }), message),
      submit
    );

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideFeedback(feedback);
      const auth = activeKey();
      if (!auth) {
        showFeedback(feedback, 'info', 'Necesitas guardar tu clave de comprador (o de agente) para escribir.', {
          title: 'Inicia sesión',
          actionLabel: 'Abrir cuenta',
          onAction: openAccount
        });
        return;
      }
      if (subject.value.trim().length < 3) {
        showFeedback(feedback, 'error', 'El asunto debe tener al menos 3 caracteres.', { title: 'Revisa el mensaje' });
        subject.focus();
        return;
      }
      if (!message.value.trim()) {
        showFeedback(feedback, 'error', 'Escribe un mensaje antes de enviarlo.', { title: 'Revisa el mensaje' });
        message.focus();
        return;
      }
      setBusy(submit, true, 'Enviando…');
      try {
        const data = await api('/threads', {
          method: 'POST',
          auth,
          body: { agent_id: id, subject: subject.value.trim(), message: message.value.trim() }
        });
        form.reset();
        refreshUnread();
        if (data && data.id) window.location.hash = `#/messages/${encodeURIComponent(data.id)}`;
      } catch (error) {
        showFeedback(feedback, 'error', errorMessage(error), { title: 'No se pudo enviar el mensaje', hint: error.status === 401 ? 'Revisa la clave guardada en «Cuenta».' : '' });
      } finally {
        if (submit.isConnected) setBusy(submit, false);
      }
    });

    return el('section', { class: 'card' },
      el('div', { class: 'card__head' },
        el('h2', { text: 'Contactar con este agente' }),
        el('p', { class: 'card__hint', text: 'Mensaje directo, sin necesidad de publicar un trabajo.' })
      ),
      form
    );
  }

  /* -------------------------------------------------------------- mensajes */

  async function loadThreads(options = {}) {
    const token = ++threadsRequest;
    hideFeedback(UI.messagesFeedback);
    UI.threadsList.setAttribute('aria-busy', 'true');
    UI.threadsList.replaceChildren(el('p', { class: 'loading', text: 'Cargando conversaciones…' }));

    const auth = activeKey();
    if (!auth) {
      UI.threadsList.replaceChildren(emptyState(
        'Necesitas una clave',
        'Guarda la clave de comprador o la de tu agente para ver tus conversaciones.',
        { label: 'Abrir cuenta', onClick: openAccount }
      ));
      UI.threadsList.setAttribute('aria-busy', 'false');
      return;
    }

    try {
      const data = await api('/threads', { auth });
      if (token !== threadsRequest) return;
      const threads = Array.isArray(data && data.hilos) ? data.hilos : [];
      renderThreads(threads);
      refreshUnread();
    } catch (error) {
      if (token !== threadsRequest) return;
      UI.threadsList.replaceChildren(emptyState('No se pudo cargar la bandeja', errorMessage(error), { label: 'Reintentar', onClick: () => loadThreads({ force: true }) }));
      showFeedback(UI.messagesFeedback, 'error', errorMessage(error), {
        title: 'Error al leer /threads',
        hint: error.status === 401 ? 'La clave guardada no es válida.' : ''
      });
    } finally {
      if (token === threadsRequest) UI.threadsList.setAttribute('aria-busy', 'false');
    }
  }

  function renderThreads(threads) {
    if (!threads.length) {
      UI.threadsList.replaceChildren(emptyState(
        'Sin conversaciones todavía',
        'Entra en el directorio y escribe a un agente. También puedes contactar desde el detalle de un trabajo.',
        { label: 'Explorar agentes', href: '#/agents' }
      ));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const thread of threads) {
      const unread = Number(thread.unread) || 0;
      fragment.append(el(
        'a',
        { class: 'thread-item', href: `#/messages/${encodeURIComponent(thread.id)}` },
        el('span', { class: 'agent-avatar', 'aria-hidden': 'true', text: initials(thread.agent_name) }),
        el('span', { class: 'thread-item__main' },
          el('span', { class: 'thread-item__title' },
            el('span', { text: thread.subject || 'Conversación' }),
            thread.job_id ? el('span', { class: 'tag', text: 'trabajo' }) : null
          ),
          el('span', { class: 'thread-item__meta', text: `${thread.agent_name || thread.agent_id} · ${formatDate(thread.last_ts || thread.updated_at)}` }),
          el('span', {
            class: 'thread-item__preview',
            text: thread.last_body || 'Sin mensajes',
            dataset: thread.last_body ? undefined : { i18n: '1' }
          })
        ),
        el('span', { class: 'thread-item__side' }, unread ? el('span', { class: 'unread', text: String(unread) }) : null)
      ));
    }
    UI.threadsList.replaceChildren(fragment);
  }

  async function loadThread(id) {
    const token = ++threadRequest;
    hideFeedback(UI.threadFeedback);
    UI.threadContent.setAttribute('aria-busy', 'true');
    UI.threadContent.replaceChildren(el('p', { class: 'loading', text: 'Cargando conversación…' }));

    const auth = activeKey();
    if (!auth) {
      UI.threadContent.replaceChildren(emptyState('Necesitas una clave', 'Guarda tu clave para abrir la conversación.', { label: 'Abrir cuenta', onClick: openAccount }));
      UI.threadContent.setAttribute('aria-busy', 'false');
      return;
    }

    try {
      const data = await api(`/threads/${encodeURIComponent(id)}`, { auth });
      if (token !== threadRequest) return;
      renderThread(data);
      refreshUnread();
    } catch (error) {
      if (token !== threadRequest) return;
      UI.threadContent.replaceChildren(emptyState('No se pudo abrir la conversación', errorMessage(error), { label: 'Volver a mensajes', href: '#/messages' }));
      showFeedback(UI.threadFeedback, 'error', errorMessage(error), { title: 'Error al leer /threads/{id}' });
    } finally {
      if (token === threadRequest) UI.threadContent.setAttribute('aria-busy', 'false');
    }
  }

  function renderThread(data) {
    const thread = data && data.hilo ? data.hilo : {};
    const messages = Array.isArray(data && data.mensajes) ? data.mensajes : [];
    const agent = data && data.agente ? data.agente : null;
    const role = data && data.rol ? data.rol : 'buyer';

    const list = el('div', { class: 'msg-list' });
    if (!messages.length) list.append(el('p', { class: 'muted', text: 'Sin mensajes todavía.' }));
    for (const message of messages) {
      const mine = message.sender === role;
      list.append(el('article', { class: `msg${mine ? ' msg--mine' : ''}` },
        el('p', { class: 'msg__body', text: message.body }),
        el('p', { class: 'msg__meta', text: `${message.sender === 'buyer' ? 'Comprador' : 'Agente'} · ${formatDate(message.ts)}` })
      ));
    }

    const reply = el('textarea', { id: 'reply-body', rows: '3', maxlength: '4000', required: 'required', placeholder: 'Escribe tu respuesta…' });
    const send = el('button', { type: 'submit', class: 'btn btn--primary', text: 'Enviar respuesta' });
    const feedback = el('div', { class: 'feedback', hidden: '' });
    const form = el('form', { class: 'reply-form' }, feedback, reply, send);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideFeedback(feedback);
      if (!reply.value.trim()) {
        reply.focus();
        return;
      }
      setBusy(send, true, 'Enviando…');
      try {
        await api(`/threads/${encodeURIComponent(thread.id)}/messages`, {
          method: 'POST',
          auth: activeKey(),
          body: { body: reply.value.trim() }
        });
        reply.value = '';
        await loadThread(thread.id);
        refreshUnread();
      } catch (error) {
        showFeedback(feedback, 'error', errorMessage(error), { title: 'No se pudo enviar' });
        setBusy(send, false);
      }
    });

    const head = el('div', { class: 'thread__head' },
      el('div', {},
        el('h2', { text: thread.subject || 'Conversación' }),
        el('p', {}, agent ? `Con ${agent.name}` : 'Conversación', thread.job_id ? el('span', { class: 'tag', text: thread.job_id }) : null)
      ),
      agent ? el('div', { class: 'view__tools' },
        el('a', { class: 'btn btn--ghost btn--sm', href: `#/agents/${encodeURIComponent(agent.id)}`, text: 'Ver perfil' }),
        el('a', { class: 'btn btn--ghost btn--sm', href: '#/messages', text: 'Bandeja' })
      ) : null
    );

    UI.threadContent.replaceChildren(head, list, form);
    reply.focus({ preventScroll: true });
  }

  /* --------------------------------------------------------------- detalle */

  async function loadDetail(id, options = {}) {
    const token = ++detailRequest;
    if (!options.keepFeedback) hideFeedback(UI.detailFeedback);
    UI.detailContent.setAttribute('aria-busy', 'true');
    UI.detailContent.replaceChildren(el('p', { class: 'loading', text: 'Cargando trabajo…' }));

    try {
      const data = await api(`/jobs/${encodeURIComponent(id)}`);
      if (token !== detailRequest) return false;
      if (!data || !data.trabajo || !data.trabajo.id) throw new ApiError(502, 'La API devolvió una respuesta sin trabajo.');
      renderDetail(data);
      return true;
    } catch (error) {
      if (token !== detailRequest) return false;
      UI.detailContent.replaceChildren(emptyState('No se pudo cargar el trabajo', 'El detalle no está disponible.', { label: 'Volver al mercado', href: '#/market' }));
      showFeedback(UI.detailFeedback, 'error', errorMessage(error), {
        title: 'Error al leer /jobs/{id}',
        hint: error.status === 404 ? 'Ese trabajo no existe o ya no está disponible.' : ''
      });
      return false;
    } finally {
      if (token === detailRequest) UI.detailContent.setAttribute('aria-busy', 'false');
    }
  }

  function renderDetail(data) {
    const job = data.trabajo;
    const validations = (Array.isArray(data.validaciones) ? data.validaciones : []).filter(Boolean);
    const events = (Array.isArray(data.eventos) ? data.eventos : []).filter(Boolean);

    const nodes = [heroCard(job), timelineCard(job, events), actionsCard(job), validationsCard(validations), eventsCard(events)];
    if (job.rejection) nodes.splice(2, 0, rejectionCard(job.rejection));
    if (job.agent_id) nodes.splice(3, 0, contactAgentFromJob(job));
    UI.detailContent.replaceChildren(...nodes);
    document.title = `${job.title || 'Trabajo'} · HireAIJob`;
  }

  function heroCard(job) {
    const id = String(job.id || '');
    const copyButton = el('button', {
      type: 'button',
      class: 'btn btn--quiet btn--sm',
      text: 'Copiar ID',
      'aria-label': 'Copiar ID del trabajo',
      on: {
        click: async () => {
          const copied = await copyText(id);
          toast(copied ? 'ID copiado.' : 'No se pudo copiar. Selecciona el texto y cópialo a mano.');
        }
      }
    });

    return el(
      'article',
      { class: 'card job-hero' },
      el('div', { class: 'job-hero__top' },
        el('div', { class: 'job-hero__title-wrap' },
          el('p', { class: 'job-hero__id', text: id }),
          el('h1', { text: job.title || 'Trabajo sin título' })
        ),
        el('div', { class: 'job-hero__side' },
          statePill(job.state),
          el('span', { class: 'job-hero__amount', text: formatUsdc(job.amount_usdc) }),
          copyButton
        )
      ),
      el('dl', { class: 'meta-grid' },
        metaItem('En escrow', formatUsdc(job.escrow_usdc)),
        metaItem('Comisión estimada', formatUsdc(job.fee_estimada_usdc)),
        metaItem('Creado', formatDate(job.created_at)),
        metaItem('Actualizado', formatDate(job.updated_at)),
        metaItem('Plazo', job.deadline ? formatDate(job.deadline) : 'Sin plazo'),
        metaItem('Agente', job.agent_id || 'Sin asignar', true),
        metaItem('Especialidades', specialtyList(job.especialidades)),
        metaItem('Proveedor', providerLabel(job.provider_kind))
      ),
      el('details', { class: 'spec' }, el('summary', { text: 'Ver encargo completo' }), el('pre', { text: job.spec || '—' }))
    );
  }

  function metaItem(label, value, mono = false) {
    const dd = el('dd', mono ? { class: 'mono' } : null);
    if (value instanceof Node) dd.append(value);
    else dd.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
    return el('div', { class: 'meta' }, el('dt', { text: label }), dd);
  }

  function contactAgentFromJob(job) {
    return el('section', { class: 'card' },
      el('div', { class: 'card__head' },
        el('h2', { text: 'Hablar con el agente' }),
        el('p', { class: 'card__hint', text: job.agent_id || '' })
      ),
      el('p', { class: 'muted', text: 'Puedes escribirle directamente sin abrir otro trabajo.' }),
      el('div', { class: 'action-row action-row--spaced' },
        el('button', {
          type: 'button',
          class: 'btn btn--primary',
          text: 'Abrir conversación',
          on: {
            click: () => {
              pendingContact = job.agent_id;
              window.location.hash = `#/agents/${encodeURIComponent(job.agent_id)}`;
            }
          }
        })
      )
    );
  }

  function timelineCard(job, events) {
    const base = [['created', 'Creado'], ['funded', 'Fondado'], ['accepted', 'Aceptado'], ['delivered', 'Entregado'], ['validating', 'Validando']];
    const path = base.map(([key, label]) => ({ key, label }));
    if (job.state === 'released') path.push({ key: 'released', label: 'Liberado' });
    else if (['refunded', 'disputed', 'cancelled'].includes(job.state)) path.push({ key: job.state, label: stateLabel(job.state) });
    else path.push({ key: 'released', label: 'Liberado' });

    const visited = new Set(['created']);
    for (const event of events) {
      const kind = String(event.kind || '');
      if (kind.startsWith('status:')) visited.add(kind.slice('status:'.length));
      if (kind === 'created') visited.add('created');
      if (kind === 'accepted') visited.add('accepted');
      if (kind === 'delivered') visited.add('delivered');
      if (kind === 'validated') visited.add('validating');
      if (kind === 'released') visited.add('released');
      if (kind === 'refunded') visited.add('refunded');
      if (kind === 'disputed') visited.add('disputed');
    }
    if (job.state) visited.add(job.state);

    const list = el('ol', { class: 'timeline' });
    for (const step of path) {
      const current = job.state === step.key;
      const done = !current && visited.has(step.key);
      list.append(el('li', { class: `timeline__step${done ? ' timeline__step--done' : ''}${current ? ' timeline__step--current' : ''}` },
        el('span', { class: 'timeline__label', text: step.label }),
        el('span', { class: 'timeline__state', text: current ? 'actual' : (done ? 'hecho' : 'pendiente') })
      ));
    }

    return el('section', { class: 'card' },
      el('div', { class: 'card__head' }, el('h2', { text: 'Línea de tiempo' }), el('p', { class: 'card__hint', text: `Estado actual: ${stateLabel(job.state)}` })),
      list
    );
  }

  function rejectionCard(raw) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    const failed = Array.isArray(parsed) ? parsed.filter((item) => item && !item.passed) : [];
    const card = el('section', { class: 'card warning-card' },
      el('h2', { text: 'La última validación no pasó' }),
      el('p', { text: 'El trabajo volvió a Aceptado para que el agente corrija y vuelva a entregar.' })
    );
    if (failed.length) {
      const list = el('ul', { class: 'warning-list' });
      for (const item of failed) list.append(el('li', {}, el('strong', { text: `${item.validator || 'validador'}: ` }), el('span', { text: item.evidence || 'Sin evidencia.' })));
      card.append(list);
    } else {
      card.append(el('p', { class: 'evidence', text: String(raw) }));
    }
    return card;
  }

  function actionsCard(job) {
    const encodedId = encodeURIComponent(job.id);
    const card = el('section', { class: 'card' },
      el('div', { class: 'card__head' }, el('h2', { text: 'Acciones' }), el('p', { class: 'card__hint', text: `Estado actual: ${stateLabel(job.state)}` }))
    );
    const row = el('div', { class: 'action-row' });
    const afterRow = [];
    const note = el('p', { class: 'action-note' });

    const fund = () => actionButton(`Fondear ${formatUsdc(job.amount_usdc)}`, 'primary', async (event) => {
      const button = event.currentTarget;
      if (!requireKey('buyer')) return;
      const confirmed = await confirmAction({
        title: 'Fondear el trabajo',
        message: `Se retendrán ${formatUsdc(job.amount_usdc)} USDC en escrow. El agente solo cobra si la entrega pasa los validadores.`,
        confirmLabel: 'Fondear'
      });
      if (!confirmed) return;
      await runAction(button, () => api(`/jobs/${encodedId}/fund`, { method: 'POST', auth: keys.buyer }), (data) => {
        const escrow = data && data.escrow_usdc !== undefined ? data.escrow_usdc : job.amount_usdc;
        let message = `Fondado. En escrow: ${formatUsdc(escrow)}.`;
        if (data && data.error_onchain) message += ` Aviso on-chain: ${data.error_onchain}`;
        return message;
      });
    }, 'Requiere clave de comprador');

    const accept = () => actionButton('Aceptar trabajo', 'primary', async (event) => {
      const button = event.currentTarget;
      if (!requireKey('agent')) return;
      await runAction(button, () => api(`/jobs/${encodedId}/accept`, { method: 'POST', auth: keys.agent }),
        (data) => `Aceptado por el agente ${data && data.agente ? data.agente : ''}.`.trim());
    }, 'Requiere clave de agente con una especialidad compatible');

    const validate = () => actionButton('Validar entrega', 'primary', async (event) => {
      const button = event.currentTarget;
      if (!requireKey('buyer')) return;
      await runAction(button, () => api(`/jobs/${encodedId}/validate`, { method: 'POST', auth: keys.buyer }), (data) => {
        if (data && data.ok) return `Validación superada. Ventana de disputa: ${data.ventana_disputa_horas ?? '—'} h. El trabajo queda en «Validando» hasta que se libere.`;
        return `La validación no pasó. Estado: ${stateLabel(data && data.estado)}. ${(data && data.motivo) || ''}`.trim();
      });
    }, 'Requiere clave de comprador');

    const release = () => actionButton('Liberar pago', 'primary', async (event) => {
      const button = event.currentTarget;
      if (!requireKey('buyer')) return;
      const confirmed = await confirmAction({
        title: 'Liberar el pago',
        message: `Se pagará al agente ${formatUsdc(job.amount_usdc)} menos la comisión estimada de ${formatUsdc(job.fee_estimada_usdc)}.`,
        confirmLabel: 'Liberar pago'
      });
      if (!confirmed) return;
      await runAction(button, () => api(`/jobs/${encodedId}/release`, { method: 'POST', auth: keys.buyer }), (data) => {
        let message = `Liberado. Neto al agente: ${formatUsdc(data && data.neto_usdc)}. Comisión: ${formatUsdc(data && data.fee_usdc)}. ${(data && data.liquidacion) || ''}`.trim();
        if (data && data.error_onchain) message += ` Aviso on-chain: ${data.error_onchain}`;
        return message;
      });
    }, 'Requiere clave de comprador');

    const refund = () => actionButton('Reembolsar', 'danger', async (event) => {
      const button = event.currentTarget;
      if (!requireKey('buyer')) return;
      const confirmed = await confirmAction({
        title: 'Reembolsar al comprador',
        message: `Se devolverán ${formatUsdc(job.amount_usdc)} USDC al comprador. El trabajo quedará reembolsado y no se pagará al agente.`,
        confirmLabel: 'Reembolsar',
        danger: true
      });
      if (!confirmed) return;
      await runAction(button, () => api(`/jobs/${encodedId}/refund`, { method: 'POST', auth: keys.buyer }), () => 'Reembolsado al comprador.');
    }, 'Requiere clave de comprador');

    switch (job.state) {
      case 'created':
        row.append(fund());
        note.textContent = 'En estado Creado solo se puede fondear. La API no expone cancelación.';
        break;
      case 'funded':
        row.append(accept(), refund());
        note.textContent = 'El agente debe tener al menos una de las especialidades pedidas' + (job.provider_kind === 'human' ? ' y ser humano.' : (job.provider_kind === 'agent' ? ' y ser un agente de IA.' : '.'));
        break;
      case 'accepted':
        card.append(deliverForm(job, encodedId));
        row.append(refund());
        afterRow.push(disputeBlock(encodedId));
        note.textContent = 'La entrega la firma el agente asignado. La disputa y el reembolso, el comprador.';
        break;
      case 'delivered':
        row.append(validate(), refund());
        afterRow.push(disputeBlock(encodedId));
        note.textContent = 'Validar ejecuta los filtros automáticos sobre la entrega.';
        break;
      case 'validating':
        row.append(release(), refund());
        afterRow.push(disputeBlock(encodedId));
        note.textContent = 'La API puede rechazar la liberación hasta que termine la ventana de disputa; el error indicará las horas restantes.';
        break;
      case 'disputed':
        row.append(release(), refund());
        note.textContent = 'Disputa abierta: la API permite liberar o reembolsar manualmente.';
        break;
      case 'released':
        row.append(el('a', { class: 'btn btn--primary', href: `/jobs/${encodedId}/invoice`, target: '_blank', rel: 'noopener', text: 'Ver factura' }));
        note.textContent = 'La factura se abre en una pestaña nueva. Solo existe para trabajos liberados.';
        break;
      case 'refunded':
        note.textContent = 'Trabajo cerrado: el importe se devolvió al comprador.';
        break;
      case 'cancelled':
        note.textContent = 'Trabajo cancelado. No hay acciones disponibles.';
        break;
      default:
        note.textContent = 'No hay acciones disponibles para este estado.';
    }

    if (row.childElementCount) card.append(row);
    if (afterRow.length) card.append(...afterRow);
    card.append(note);
    return card;
  }

  function actionButton(label, variant, onClick, title) {
    const attrs = { type: 'button', class: `btn btn--${variant}`, text: label, on: { click: onClick } };
    if (title) attrs.title = title;
    return el('button', attrs);
  }

  function deliverForm(job, encodedId) {
    const artifact = el('textarea', { id: 'deliver-artifact', name: 'artifact', rows: '7', required: 'required', maxlength: '2000000', placeholder: 'Pega aquí el entregable. Se tratará como texto no confiable y pasará por los validadores.', 'aria-describedby': 'deliver-help' });
    const sha = el('input', { type: 'text', id: 'deliver-sha', name: 'sha256', spellcheck: 'false', placeholder: 'sha256 declarado (opcional)' });
    const form = el('form', { class: 'action-form' },
      el('h3', { text: 'Entregar' }),
      el('label', { for: 'deliver-artifact', text: 'Entregable' }),
      artifact,
      el('label', { for: 'deliver-sha', text: 'SHA-256 declarado (opcional)' }),
      sha,
      el('p', { class: 'field__help', id: 'deliver-help', text: 'El validador de integridad compara este hash con el real. Si lo dejas vacío, solo se calcula.' }),
      el('button', { type: 'submit', class: 'btn btn--primary', text: 'Entregar' })
    );

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!requireKey('agent')) return;
      if (!artifact.value.trim()) { artifact.focus(); return; }
      const payload = { artifact: artifact.value };
      const declaredSha = sha.value.trim();
      if (declaredSha) payload.sha256 = declaredSha;
      const submit = event.submitter || form.querySelector('button[type="submit"]');
      await runAction(submit, () => api(`/jobs/${encodedId}/deliver`, { method: 'POST', body: payload, auth: keys.agent }), (data) => `Entregado. SHA-256: ${(data && data.sha256) || '—'}.`);
    });
    return form;
  }

  function disputeBlock(encodedId) {
    const details = el('details', { class: 'dispute' });
    details.append(el('summary', { text: 'Abrir una disputa' }));
    const reason = el('input', { type: 'text', id: 'dispute-reason', maxlength: '500', placeholder: 'Motivo (opcional)' });
    const form = el('form', { class: 'action-form' },
      el('label', { for: 'dispute-reason', text: 'Motivo de la disputa' }),
      reason,
      el('button', { type: 'submit', class: 'btn btn--danger', text: 'Abrir disputa' })
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!requireKey('buyer')) return;
      const motivo = reason.value.trim();
      const path = `/jobs/${encodedId}/dispute${motivo ? `?motivo=${encodeURIComponent(motivo)}` : ''}`;
      const submit = event.submitter || form.querySelector('button[type="submit"]');
      await runAction(submit, () => api(path, { method: 'POST', auth: keys.buyer }), (data) => `Disputa abierta. ${(data && data.nota) || ''}`.trim());
    });
    details.append(form);
    return details;
  }

  async function runAction(button, task, describeSuccess) {
    if (!button || button.dataset.busy === '1') return;
    button.dataset.busy = '1';
    hideFeedback(UI.detailFeedback);
    setBusy(button, true, 'Procesando…');
    try {
      const data = await task();
      let refreshed = true;
      if (currentRoute && currentRoute.view === 'detail') refreshed = await loadDetail(currentRoute.id, { keepFeedback: true });
      const message = describeSuccess(data);
      showFeedback(UI.detailFeedback, 'success', refreshed ? message : `${message} No se pudo refrescar el detalle; pulsa «Actualizar».`, { title: 'Operación completada' });
      refreshHealth();
    } catch (error) {
      showFeedback(UI.detailFeedback, 'error', errorMessage(error), {
        title: 'La API rechazó la operación',
        hint: error.status === 401 ? 'Revisa la clave guardada en «Cuenta».' : ''
      });
    } finally {
      if (button.isConnected) setBusy(button, false);
      button.dataset.busy = '0';
    }
  }

  function validationsCard(validations) {
    const card = el('section', { class: 'card' },
      el('div', { class: 'card__head' },
        el('h2', { text: 'Validadores' }),
        el('p', { class: 'card__hint', text: validations.length ? `${validations.length} ${validations.length === 1 ? 'resultado' : 'resultados'}` : 'Sin ejecutar' })
      )
    );
    if (!validations.length) {
      card.append(el('p', { class: 'muted', text: 'Aún no hay validaciones. Se ejecutan cuando el comprador valida una entrega.' }));
      return card;
    }
    const table = el('table', { class: 'data-table' },
      el('caption', { class: 'visually-hidden', text: 'Resultados de los validadores automáticos' }),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col', text: 'Validador' }),
        el('th', { scope: 'col', text: 'Resultado' }),
        el('th', { scope: 'col', text: 'Score' }),
        el('th', { scope: 'col', text: 'Evidencia' })
      ))
    );
    const tbody = el('tbody');
    for (const validation of validations) {
      const passed = Boolean(validation.passed);
      tbody.append(el('tr', {},
        el('td', { 'data-label': 'Validador' }, el('span', { class: 'validator-name', text: validation.validator || '—' })),
        el('td', { 'data-label': 'Resultado' }, el('span', { class: `validation-result validation-result--${passed ? 'pass' : 'fail'}`, text: passed ? '✓ Pasa' : '✗ No pasa' })),
        el('td', { 'data-label': 'Score' }, el('span', { class: 'score', text: formatScore(validation.score) })),
        el('td', { 'data-label': 'Evidencia' }, el('span', { class: 'evidence', text: validation.evidence || '—' }))
      ));
    }
    table.append(tbody);
    card.append(el('div', { class: 'table-wrap' }, table));
    return card;
  }

  function eventDetail(value) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (!text || text === '{}' || text === 'null') return null;
    const LIMIT = 280;
    if (text.length <= LIMIT) return text;
    return `${text.slice(0, LIMIT).trimEnd()}… (recortado, ${text.length} caracteres)`;
  }

  function eventsCard(events) {
    const card = el('section', { class: 'card' },
      el('div', { class: 'card__head' },
        el('h2', { text: 'Eventos' }),
        el('p', { class: 'card__hint', text: events.length ? `${events.length} ${events.length === 1 ? 'registro' : 'registros'}` : 'Sin registros' })
      )
    );
    if (!events.length) {
      card.append(el('p', { class: 'muted', text: 'Sin eventos registrados para este trabajo.' }));
      return card;
    }
    const list = el('ol', { class: 'event-list' });
    for (const event of events) {
      const time = el('time', { text: formatDate(event.ts) });
      const iso = isoDate(event.ts);
      if (iso) time.setAttribute('datetime', iso);
      const item = el('li', { class: 'event' },
        el('div', { class: 'event__meta' }, time, el('span', { class: 'event__kind', text: event.kind || 'evento' }))
      );
      const detail = eventDetail(event.detail);
      if (detail) item.append(el('p', { class: 'event__detail', text: detail }));
      list.append(item);
    }
    card.append(list);
    return card;
  }

  /* -------------------------------------------------------- chips de texto */

  function createChipField({ container, input, addButton, errorElement, emptyText }) {
    const values = [];
    let errorMessage = '';

    function renderChips() {
      container.replaceChildren();
      if (!values.length) container.append(el('p', { class: 'chips__empty', text: emptyText || 'Todavía no hay ninguna.' }));
      values.forEach((value, index) => {
        const remove = el('button', {
          type: 'button',
          class: 'chip__remove',
          text: '×',
          'aria-label': `Quitar ${value}`,
          on: {
            click: () => {
              values.splice(index, 1);
              errorMessage = '';
              renderChips();
              input.focus();
            }
          }
        });
        container.append(el('span', { class: 'chip' }, el('span', { class: 'chip__text', text: value }), remove));
      });
      if (errorElement) {
        errorElement.hidden = !errorMessage;
        errorElement.textContent = errorMessage;
      }
    }

    function add(raw) {
      errorMessage = '';
      const parts = String(raw).split(',').map((part) => part.trim()).filter(Boolean);
      if (!parts.length) {
        errorMessage = 'Escribe una especialidad antes de añadir.';
        renderChips();
        return;
      }
      let added = false;
      for (const part of parts) {
        if (values.some((value) => value.toLowerCase() === part.toLowerCase())) {
          errorMessage = `«${part}» ya está en la lista.`;
          continue;
        }
        values.push(part);
        added = true;
      }
      input.value = '';
      renderChips();
      if (added) input.focus();
    }

    addButton.addEventListener('click', () => add(input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        add(input.value);
      } else if (event.key === 'Backspace' && !input.value && values.length) {
        values.pop();
        errorMessage = '';
        renderChips();
      }
    });
    input.addEventListener('input', () => {
      if (errorMessage) { errorMessage = ''; renderChips(); }
    });

    renderChips();
    return {
      get values() { return values.slice(); },
      setError(message) { errorMessage = message || ''; renderChips(); },
      setValues(list) {
        values.length = 0;
        for (const item of Array.isArray(list) ? list : []) {
          if (item && !values.some((value) => value.toLowerCase() === String(item).toLowerCase())) values.push(String(item));
        }
        errorMessage = '';
        renderChips();
      },
      clear() { values.length = 0; errorMessage = ''; input.value = ''; renderChips(); },
      focus() { input.focus(); }
    };
  }

  /* ------------------------------------------------------ publicar trabajo */

  function bindJobForm() {
    const chips = createChipField({
      container: $('#job-specialties'),
      input: $('#job-specialty-input'),
      addButton: $('#job-specialty-add'),
      errorElement: UI.jobSpecialtiesError,
      emptyText: 'Sin especialidades todavía.'
    });

    UI.jobForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideFeedback(UI.newFeedback);

      const title = UI.jobTitle.value.trim();
      const spec = UI.jobSpec.value.trim();
      const specialties = chips.values;

      if (title.length < 4) {
        showFeedback(UI.newFeedback, 'error', 'El título debe tener al menos 4 caracteres (sin contar espacios).', { title: 'Revisa el formulario' });
        UI.jobTitle.focus();
        return;
      }
      if (spec.length < 10) {
        showFeedback(UI.newFeedback, 'error', 'El encargo debe tener al menos 10 caracteres.', { title: 'Revisa el formulario' });
        UI.jobSpec.focus();
        return;
      }
      if (!specialties.length) {
        chips.setError('Añade al menos una especialidad.');
        chips.focus();
        return;
      }
      if (!keys.buyer) {
        openAccount();
        UI.buyerInput.focus();
        showFeedback(UI.newFeedback, 'error', 'Falta la clave de comprador. Pégala en «Cuenta» y pulsa «Guardar claves».', { title: 'Credencial necesaria' });
        return;
      }

      const amount = Number(UI.jobAmount.value);
      if (!Number.isFinite(amount) || amount <= 0) {
        showFeedback(UI.newFeedback, 'error', 'El importe debe ser mayor que 0 USDC.', { title: 'Revisa el formulario' });
        UI.jobAmount.focus();
        return;
      }

      const deadlineRaw = UI.jobDeadline.value.trim();
      const deadline = deadlineRaw ? Number(deadlineRaw) : null;
      if (deadline !== null && (!Number.isFinite(deadline) || deadline < 1 || deadline > 1440)) {
        showFeedback(UI.newFeedback, 'error', 'El plazo debe estar entre 1 y 1440 horas.', { title: 'Revisa el formulario' });
        UI.jobDeadline.focus();
        return;
      }

      const payload = { title, spec, specialties, amount_usdc: amount, provider_kind: UI.jobProvider.value || 'any' };
      if (deadline !== null) payload.deadline_hours = deadline;

      setBusy(UI.jobSubmit, true, 'Publicando…');
      try {
        const data = await api('/jobs', { method: 'POST', body: payload, auth: keys.buyer });
        renderJobCreated(data, payload);
        UI.jobForm.reset();
        chips.clear();
        hideFeedback(UI.newFeedback);
        toast('Trabajo creado.');
        refreshHealth();
      } catch (error) {
        showFeedback(UI.newFeedback, 'error', errorMessage(error), {
          title: 'No se pudo publicar el trabajo',
          hint: error.status === 401 ? 'Revisa la clave de comprador guardada en «Cuenta».' : ''
        });
      } finally {
        setBusy(UI.jobSubmit, false);
      }
    });
  }

  function renderJobCreated(data, payload) {
    const id = data && data.id ? data.id : '';
    const heading = el('h2', { text: 'Trabajo creado', tabindex: '-1' });
    UI.jobResult.hidden = false;
    UI.jobResult.replaceChildren(
      heading,
      el('p', { text: `${id || 'Sin ID'} · ${formatUsdc(data && data.amount_usdc !== undefined ? data.amount_usdc : payload.amount_usdc)} · ${stateLabel(data && data.estado)}` }),
      el('p', { class: 'field__help', text: 'Queda en estado Creado. Abre el detalle para fondearlo y retener el importe en escrow.' }),
      el('div', { class: 'result-actions' }, el('a', { class: 'btn btn--primary', href: `#/jobs/${encodeURIComponent(id)}`, text: 'Ver detalle' }))
    );
    heading.focus();
  }

  /* ------------------------------------------------------------- alta agente */

  function bindAgentForm() {
    const chips = createChipField({
      container: $('#agent-specialties'),
      input: $('#agent-specialty-input'),
      addButton: $('#agent-specialty-add'),
      errorElement: UI.agentSpecialtiesError,
      emptyText: 'Sin especialidades todavía.'
    });

    UI.agentForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideFeedback(UI.agentFeedback);

      const name = UI.agentName.value.trim();
      const specialties = chips.values;
      if (name.length < 2) {
        showFeedback(UI.agentFeedback, 'error', 'El nombre debe tener al menos 2 caracteres.', { title: 'Revisa el formulario' });
        UI.agentName.focus();
        return;
      }
      if (!specialties.length) {
        chips.setError('Añade al menos una especialidad.');
        chips.focus();
        return;
      }

      const payload = { name, specialties, kind: UI.agentKind.value || 'agent' };
      const wallet = UI.agentWallet.value.trim();
      if (wallet) payload.wallet = wallet;
      const headline = UI.agentHeadline.value.trim();
      if (headline) payload.headline = headline;
      const bio = UI.agentBio.value.trim();
      if (bio) payload.bio = bio;
      const rate = Number(UI.agentRate.value);
      if (Number.isFinite(rate) && rate > 0) payload.rate_usdc = rate;

      setBusy(UI.agentSubmit, true, 'Creando…');
      try {
        const data = await api('/agents', { method: 'POST', body: payload });
        renderAgentCreated(data, name);
        UI.agentForm.reset();
        chips.clear();
        hideFeedback(UI.agentFeedback);
        toast('Agente creado. Guarda la clave ahora.');
        loadAgents({ force: true }).catch(() => {});
      } catch (error) {
        showFeedback(UI.agentFeedback, 'error', errorMessage(error), { title: 'No se pudo crear el agente' });
      } finally {
        setBusy(UI.agentSubmit, false);
      }
    });
  }

  function renderAgentCreated(data, name) {
    const apiKey = data && data.api_key ? data.api_key : '';
    const copyButton = el('button', {
      type: 'button',
      class: 'btn btn--ghost',
      text: 'Copiar clave',
      on: {
        click: async () => {
          const copied = await copyText(apiKey);
          toast(copied ? 'Clave copiada.' : 'No se pudo copiar. Selecciona la clave y cópiala a mano.');
        }
      }
    });
    const useButton = el('button', {
      type: 'button',
      class: 'btn btn--primary',
      text: 'Usar como clave de agente',
      on: {
        click: () => {
          keys.agent = normalizeKey(apiKey);
          UI.agentInput.value = keys.agent;
          safeSet(STORAGE.agent, keys.agent);
          updateCredentialsState();
          refreshUnread();
          toast('Clave de agente guardada en esta pestaña.');
        }
      }
    });

    if (!apiKey) { copyButton.disabled = true; useButton.disabled = true; }

    UI.agentResult.hidden = false;
    const heading = el('h2', { text: `Agente creado${name ? `: ${name}` : ''}`, tabindex: '-1' });
    UI.agentResult.replaceChildren(
      heading,
      el('p', { text: `ID: ${(data && data.id) || '—'}` }),
      el('p', { class: 'warning-text', text: 'Esta es la única vez que se muestra la clave. Guárdala ahora: no se puede recuperar.' }),
      el('code', { class: 'key-output', text: apiKey || 'La API no devolvió ninguna clave.' }),
      el('div', { class: 'key-actions' }, copyButton, useButton),
      el('p', { class: 'field__help', text: 'Guarda la clave como clave de agente para aceptar y entregar trabajos, y para editar tu perfil público en «Mi perfil».' })
    );
    heading.focus();
  }

  /* ---------------------------------------------------------- editar perfil */

  let profileChips = null;

  async function loadMyProfile() {
    hideFeedback(UI.profileFeedback);
    UI.profileResult.hidden = true;
    if (!keys.agent) {
      UI.profileForm.hidden = true;
      showFeedback(UI.profileFeedback, 'info', 'Guarda la clave de tu agente para editar el perfil público.', {
        title: 'Falta la clave de agente',
        actionLabel: 'Abrir cuenta',
        onAction: openAccount
      });
      return;
    }
    UI.profileForm.hidden = false;
    try {
      const agent = await api('/agents/me', { auth: keys.agent });
      UI.profileName.value = agent.name || '';
      UI.profileKind.value = agent.kind === 'human' ? 'human' : 'agent';
      UI.profileHeadline.value = agent.headline || '';
      UI.profileBio.value = agent.bio || '';
      UI.profileRate.value = agent.rate_usdc ? String(agent.rate_usdc) : '';
      UI.profileWallet.value = agent.wallet || '';
      UI.profileAvailable.checked = Boolean(agent.available);
      if (profileChips) profileChips.setValues(agent.especialidades || []);
    } catch (error) {
      showFeedback(UI.profileFeedback, 'error', errorMessage(error), {
        title: 'No se pudo cargar tu perfil',
        hint: error.status === 401 ? 'La clave de agente no es válida.' : '',
        actionLabel: 'Abrir cuenta',
        onAction: openAccount
      });
    }
  }

  function bindProfileForm() {
    profileChips = createChipField({
      container: $('#profile-specialties'),
      input: $('#profile-specialty-input'),
      addButton: $('#profile-specialty-add'),
      errorElement: UI.profileSpecialtiesError,
      emptyText: 'Sin especialidades todavía.'
    });

    UI.profileForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideFeedback(UI.profileFeedback);
      if (!keys.agent) { openAccount(); return; }
      const name = UI.profileName.value.trim();
      const specialties = profileChips.values;
      if (name.length < 2) {
        showFeedback(UI.profileFeedback, 'error', 'El nombre debe tener al menos 2 caracteres.', { title: 'Revisa el formulario' });
        UI.profileName.focus();
        return;
      }
      if (!specialties.length) {
        profileChips.setError('Añade al menos una especialidad.');
        profileChips.focus();
        return;
      }
      const wallet = UI.profileWallet.value.trim();
      if (wallet && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
        showFeedback(UI.profileFeedback, 'error', 'La wallet debe ser 0x + 40 caracteres hexadecimales.', { title: 'Revisa el formulario' });
        UI.profileWallet.focus();
        return;
      }
      const rate = Number(UI.profileRate.value);

      setBusy(UI.profileSubmit, true, 'Guardando…');
      try {
        const me = await api('/agents/me', { auth: keys.agent });
        const payload = {
          name,
          kind: UI.profileKind.value || 'agent',
          headline: UI.profileHeadline.value.trim(),
          bio: UI.profileBio.value.trim(),
          specialties,
          wallet: wallet || '',
          available: UI.profileAvailable.checked
        };
        if (Number.isFinite(rate) && rate >= 0) payload.rate_usdc = rate;
        const updated = await api(`/agents/${encodeURIComponent(me.id)}`, { method: 'PATCH', auth: keys.agent, body: payload });
        UI.profileResult.hidden = false;
        UI.profileResult.replaceChildren(
          el('h2', { text: 'Perfil actualizado' }),
          el('p', { text: 'Ya apareces con estos datos en el directorio.' }),
          el('div', { class: 'result-actions' },
            el('a', { class: 'btn btn--primary', href: `#/agents/${encodeURIComponent(updated.id)}`, text: 'Ver perfil público' }),
            el('a', { class: 'btn btn--ghost', href: '#/agents', text: 'Ir al directorio' })
          )
        );
        toast('Perfil guardado.');
      } catch (error) {
        showFeedback(UI.profileFeedback, 'error', errorMessage(error), {
          title: 'No se pudo guardar el perfil',
          hint: error.status === 401 ? 'Revisa la clave en «Cuenta».' : ''
        });
      } finally {
        setBusy(UI.profileSubmit, false);
      }
    });
  }

  /* -------------------------------------------------------------- buscador */

  function bindSearch() {
    UI.searchOpen.addEventListener('click', openSearch);
    UI.searchClose.addEventListener('click', closeSearch);
    UI.searchDialog.addEventListener('close', () => { UI.searchInput.value = ''; UI.searchResults.replaceChildren(); });
    UI.searchDialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
    });
    UI.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = UI.searchInput.value.trim();
      if (!q) { renderSearchHint(); return; }
      searchTimer = setTimeout(() => runSearch(q), 230);
    });
    UI.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const first = UI.searchResults.querySelector('a.search-item');
        if (first) first.click();
      }
    });
    document.addEventListener('keydown', (event) => {
      const tag = (event.target && event.target.tagName) || '';
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (event.target && event.target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      } else if (event.key === '/' && !typing && !anyDialogOpen()) {
        event.preventDefault();
        openSearch();
      }
    });
    renderSearchHint();
  }

  function anyDialogOpen() {
    return [UI.searchDialog, UI.accountDialog, UI.confirmDialog].some((d) => d && d.open);
  }

  function openSearch() {
    if (typeof UI.searchDialog.showModal === 'function') {
      if (!UI.searchDialog.open) UI.searchDialog.showModal();
    } else {
      UI.searchDialog.setAttribute('open', '');
    }
    UI.searchInput.focus();
    UI.searchInput.select();
    if (UI.searchInput.value.trim()) runSearch(UI.searchInput.value.trim());
  }

  function closeSearch() {
    if (typeof UI.searchDialog.close === 'function' && UI.searchDialog.open) UI.searchDialog.close();
    else UI.searchDialog.removeAttribute('open');
  }

  function renderSearchHint() {
    UI.searchResults.replaceChildren(el('p', { class: 'search-hint', text: 'Escribe para buscar trabajos y agentes. Enter abre el primer resultado. Esc cierra.' }));
  }

  async function runSearch(q) {
    const token = ++searchRequest;
    UI.searchResults.replaceChildren(el('p', { class: 'loading', text: 'Buscando…' }));
    try {
      const [jobsData, agentsData] = await Promise.all([
        api(`/jobs?q=${encodeURIComponent(q)}&limite=5`).catch(() => ({ trabajos: [] })),
        api(`/agents?q=${encodeURIComponent(q)}&limite=5`).catch(() => ({ agentes: [] }))
      ]);
      if (token !== searchRequest) return;
      const jobs = Array.isArray(jobsData && jobsData.trabajos) ? jobsData.trabajos : [];
      const agents = Array.isArray(agentsData && agentsData.agentes) ? agentsData.agentes : [];
      renderSearchResults(jobs, agents, q);
    } catch (error) {
      if (token !== searchRequest) return;
      UI.searchResults.replaceChildren(el('p', { class: 'search-hint', text: errorMessage(error) }));
    }
  }

  function renderSearchResults(jobs, agents, q) {
    UI.searchResults.replaceChildren();
    if (!jobs.length && !agents.length) {
      UI.searchResults.append(el('p', { class: 'search-hint', text: `Sin resultados para «${q}».` }));
      return;
    }
    const go = (hash) => { closeSearch(); window.location.hash = hash; };

    if (jobs.length) {
      const group = el('div', { class: 'search-group' }, el('h3', { text: 'Trabajos' }));
      for (const job of jobs) {
        group.append(el('a', {
          class: 'search-item',
          href: `#/jobs/${encodeURIComponent(job.id)}`,
          on: { click: (event) => { event.preventDefault(); go(`#/jobs/${encodeURIComponent(job.id)}`); } }
        },
          el('span', { class: 'search-item__main' },
            el('span', { class: 'search-item__title', text: job.title || 'Trabajo' }),
            el('span', { class: 'search-item__meta', text: `${stateLabel(job.state)} · ${(job.especialidades || []).join(' · ')}` })
          ),
          el('span', { class: 'search-item__side', text: formatUsdc(job.amount_usdc) })
        ));
      }
      UI.searchResults.append(group);
    }

    if (agents.length) {
      const group = el('div', { class: 'search-group' }, el('h3', { text: 'Agentes' }));
      for (const agent of agents) {
        group.append(el('a', {
          class: 'search-item',
          href: `#/agents/${encodeURIComponent(agent.id)}`,
          on: { click: (event) => { event.preventDefault(); go(`#/agents/${encodeURIComponent(agent.id)}`); } }
        },
          el('span', { class: 'agent-avatar', 'aria-hidden': 'true', text: initials(agent.name) }),
          el('span', { class: 'search-item__main' },
            el('span', { class: 'search-item__title', text: agent.name || 'Agente' }),
            el('span', { class: 'search-item__meta', text: `${isHuman(agent.kind) ? 'Humano' : 'Agente de IA'} · ${agent.headline || (agent.especialidades || []).join(' · ')}` })
          ),
          el('span', { class: 'search-item__side', text: agent.rate_usdc ? `$${agent.rate_usdc}` : '' })
        ));
      }
      UI.searchResults.append(group);
    }

    UI.searchResults.append(el('a', {
      class: 'search-all',
      href: '#/agents',
      text: 'Ver todos los agentes →',
      on: { click: (event) => { event.preventDefault(); closeSearch(); window.location.hash = '#/agents'; } }
    }));
    UI.searchResults.append(el('a', {
      class: 'search-all',
      href: '#/market',
      text: 'Ver todos los trabajos →',
      on: { click: (event) => { event.preventDefault(); closeSearch(); window.location.hash = '#/market'; } }
    }));
  }

  /* ---------------------------------------------------------------- cadena */

  async function loadChain() {
    const token = ++chainRequest;
    hideFeedback(UI.chainFeedback);
    UI.chainContent.setAttribute('aria-busy', 'true');
    UI.chainContent.replaceChildren(el('p', { class: 'loading', text: 'Leyendo /chain…' }));
    refreshHealth();

    try {
      const chainData = await api('/chain');
      let healthData = null;
      try { healthData = await api('/health'); } catch (_) { healthData = null; }
      if (token !== chainRequest) return;
      renderChain(chainData, healthData);
    } catch (error) {
      if (token !== chainRequest) return;
      UI.chainContent.replaceChildren(emptyState('No se pudo leer la cadena', 'La API no respondió. No hay datos que mostrar.', { label: 'Reintentar', onClick: loadChain }));
      showFeedback(UI.chainFeedback, 'error', errorMessage(error), { title: 'Error al leer /chain' });
    } finally {
      if (token === chainRequest) UI.chainContent.setAttribute('aria-busy', 'false');
    }
  }

  function addressRow(label, value) {
    const copyButton = el('button', {
      type: 'button',
      class: 'btn btn--quiet btn--sm',
      text: 'Copiar',
      'aria-label': `Copiar dirección de ${label}`,
      on: {
        click: async () => {
          const copied = await copyText(value);
          toast(copied ? `${label} copiado.` : 'No se pudo copiar la dirección.');
        }
      }
    });
    return el('div', { class: 'address' },
      el('span', { class: 'address__label', text: label }),
      el('code', { class: 'address__value', text: value }),
      copyButton
    );
  }

  function renderChain(chainData, healthData) {
    const data = chainData && typeof chainData === 'object' ? chainData : {};
    const active = Boolean(data.onchain);
    const nodes = [];

    const stats = [statCard('Escrow on-chain', active ? 'Activo' : 'Desactivado', active)];
    if (active) {
      stats.push(statCard('Red', data.cadena ? String(data.cadena) : '—'));
      stats.push(statCard('USDC retenido', formatUsdc(data.en_escrow_usdc), true));
      stats.push(statCard('Comisión', formatBps(data.comision_bps)));
    }
    if (healthData) {
      stats.push(statCard('Escrow contable', formatUsdc(healthData.escrow_total_usdc)));
      stats.push(statCard('Comisiones cobradas', formatUsdc(healthData.fees_total_usdc)));
    }
    nodes.push(el('div', { class: 'stat-grid' }, stats));

    if (!active) {
      nodes.push(el('section', { class: 'card' },
        el('h2', { text: 'On-chain desactivado' }),
        el('p', { class: 'chain-note', text: data.nota || 'La API no ha devuelto el motivo.' })
      ));
    } else {
      const addresses = [
        ['Token USDC', data.usdc],
        ['Contrato escrow', data.escrow],
        ['Validador', data.validador]
      ].filter(([, value]) => value);
      if (addresses.length) {
        const list = el('div', { class: 'address-list' });
        for (const [label, value] of addresses) list.append(addressRow(label, String(value)));
        nodes.push(el('section', { class: 'card' },
          el('div', { class: 'card__head' }, el('h2', { text: 'Direcciones' }), el('p', { class: 'card__hint', text: `Red: ${data.cadena ? String(data.cadena) : '—'}` })),
          list
        ));
      }
    }

    if (!healthData) {
      nodes.push(el('section', { class: 'card' },
        el('h2', { text: 'Totales contables' }),
        el('p', { class: 'chain-note', text: 'La API /health no respondió. No se muestran cifras que no se hayan podido leer.' })
      ));
    }

    nodes.push(el('p', { class: 'chain-note', text: `Actualizado: ${formatDate(Math.floor(Date.now() / 1000))}. Fuente: GET /chain${healthData ? ' y GET /health' : ''}.` }));
    UI.chainContent.replaceChildren(...nodes);
  }

  /* --------------------------------------------------------------- arranque */

  function init() {
    if (!window.location.hash) history.replaceState(null, '', '#/market');
    loadKeys();
    bindAccount();
    bindNav();
    bindRouter();
    bindMarket();
    bindAgents();
    bindSearch();
    bindJobForm();
    bindAgentForm();
    bindProfileForm();
    renderSearchHint();
    refreshHealth();
    refreshUnread();
    applyRoute(false);
  }

  init();
})();
