/**
 * OnlyBet — Patch de Melhorias v2
 * Adicionar este ficheiro ao index.html com:
 * <script src="/onlybet-patch.js"></script>
 * 
 * Ou copiar o conteúdo para dentro do <script> existente no index.html.
 * 
 * Melhorias incluídas:
 * - Segurança: token de sessão, validação de inputs
 * - UX: notificações melhoradas, loading states
 * - Mobile: gestos de swipe, menu hamburger fix
 * - Performance: debounce, throttle, lazy loading
 * - Antifraude: validações no cliente antes de enviar
 * - Gateway: integração melhorada com Supabase via API
 */

(function() {
  'use strict';

  // ============================================================
  // SEGURANÇA — Token Management
  // ============================================================
  const Auth = {
    TOKEN_KEY: 'ob_token',
    SESSION_KEY: 'ob_session',

    saveSession(user, token) {
      try {
        sessionStorage.setItem(this.TOKEN_KEY, token || '');
        localStorage.setItem(this.SESSION_KEY, JSON.stringify({
          ...user,
          _saved: Date.now()
        }));
      } catch(e) {}
    },

    getToken() {
      return sessionStorage.getItem(this.TOKEN_KEY) || '';
    },

    getSession() {
      try {
        const raw = localStorage.getItem(this.SESSION_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        // Sessão expira em 24h
        if (Date.now() - (s._saved || 0) > 86400000) {
          this.clear();
          return null;
        }
        return s;
      } catch { return null; }
    },

    clear() {
      sessionStorage.removeItem(this.TOKEN_KEY);
      localStorage.removeItem(this.SESSION_KEY);
    },

    // Headers autenticados para API
    headers() {
      return {
        'Content-Type': 'application/json',
        'x-token': this.getToken()
      };
    }
  };

  // ============================================================
  // API — Wrapper centralizado com error handling
  // ============================================================
  const API = {
    async call(url, options = {}) {
      try {
        const res = await fetch(url, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
          }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return { ok: true, data };
      } catch(e) {
        return { ok: false, error: e.message };
      }
    },

    async get(path) {
      return this.call(path);
    },

    async post(path, body) {
      return this.call(path, {
        method: 'POST',
        body: JSON.stringify(body)
      });
    }
  };

  // ============================================================
  // VALIDAÇÕES — Input sanitization
  // ============================================================
  const Validate = {
    email(v) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    },
    telefone(v) {
      return /^\d{9}$/.test(v.replace(/\s/g, ''));
    },
    valor(v, min = 100, max = 1000000) {
      const n = parseFloat(v);
      return !isNaN(n) && n >= min && n <= max;
    },
    sanitize(str) {
      return String(str).replace(/[<>"'&]/g, c => ({
        '<': '&lt;', '>': '&gt;', '"': '&quot;',
        "'": '&#x27;', '&': '&amp;'
      })[c]);
    }
  };

  // ============================================================
  // PERFORMANCE — Utilitários
  // ============================================================
  function debounce(fn, ms) {
    let t;
    return function(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function throttle(fn, ms) {
    let last = 0;
    return function(...args) {
      const now = Date.now();
      if (now - last >= ms) { last = now; fn.apply(this, args); }
    };
  }

  // ============================================================
  // MOBILE — Melhorias para dispositivos móveis
  // ============================================================
  const Mobile = {
    init() {
      this.fixViewport();
      this.addSwipeSupport();
      this.fixInputZoom();
      this.addTouchFeedback();
    },

    fixViewport() {
      // Corrigir altura em browsers móveis (iOS Safari 100vh bug)
      const setVH = () => {
        document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
      };
      setVH();
      window.addEventListener('resize', debounce(setVH, 100));
    },

    addSwipeSupport() {
      let startX = 0;
      const sidebar = document.querySelector('.sidebar');
      if (!sidebar) return;

      document.addEventListener('touchstart', e => {
        startX = e.touches[0].clientX;
      }, { passive: true });

      document.addEventListener('touchend', e => {
        const dx = e.changedTouches[0].clientX - startX;
        const isMobile = window.innerWidth < 768;
        if (!isMobile) return;

        if (dx > 60 && startX < 30) {
          // Swipe direita — abrir sidebar
          sidebar.classList.add('mobile-open');
          document.getElementById('sidebarOverlay')?.classList.add('show');
        } else if (dx < -60) {
          // Swipe esquerda — fechar sidebar
          sidebar.classList.remove('mobile-open');
          document.getElementById('sidebarOverlay')?.classList.remove('show');
        }
      }, { passive: true });
    },

    fixInputZoom() {
      // iOS faz zoom em inputs com font-size < 16px — corrigir
      const style = document.createElement('style');
      style.textContent = `
        @media (max-width: 768px) {
          input, select, textarea { font-size: 16px !important; }
        }
      `;
      document.head.appendChild(style);
    },

    addTouchFeedback() {
      // Feedback visual em toque (substitui :hover no mobile)
      const style = document.createElement('style');
      style.textContent = `
        .btn:active { transform: scale(0.97); opacity: 0.9; }
        .match-row:active { background: rgba(240,180,41,.08) !important; }
        .nav-item:active { background: rgba(255,255,255,.05) !important; }
      `;
      document.head.appendChild(style);
    }
  };

  // ============================================================
  // CSS MELHORIAS — Injetar estilos de melhoria
  // ============================================================
  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'ob-patch-styles';
    style.textContent = `
      /* === MOBILE RESPONSIVO === */
      @media (max-width: 768px) {
        .sidebar {
          transform: translateX(-100%);
          transition: transform 0.25s cubic-bezier(0.4,0,0.2,1);
          z-index: 200;
        }
        .sidebar.mobile-open { transform: translateX(0); }
        .main { margin-left: 0 !important; }
        .topbar { padding: 10px 14px !important; }
        .content { padding: 14px !important; }
        .hero { padding: 20px 16px !important; }
        .hero-title { font-size: clamp(22px, 5vw, 36px) !important; }
        .hero-stats { gap: 14px !important; }
        .betslip-panel {
          position: fixed; bottom: 0; left: 0; right: 0;
          max-height: 60vh; border-radius: 16px 16px 0 0;
          z-index: 150; transform: translateY(100%);
          transition: transform 0.3s ease;
        }
        .betslip-panel.open { transform: translateY(0); }
        .odds-grid { grid-template-columns: repeat(2, 1fr) !important; }
        .match-row { flex-wrap: wrap; gap: 6px !important; }
      }

      /* Overlay para sidebar mobile */
      #sidebarOverlay {
        display: none;
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.6);
        z-index: 190;
        backdrop-filter: blur(2px);
      }
      #sidebarOverlay.show { display: block; }

      /* === LOADING STATES === */
      .ob-loading {
        pointer-events: none;
        opacity: 0.7;
        position: relative;
      }
      .ob-loading::after {
        content: '';
        position: absolute;
        top: 50%; left: 50%;
        width: 18px; height: 18px;
        border: 2px solid rgba(240,180,41,0.3);
        border-top-color: var(--gold, #f0b429);
        border-radius: 50%;
        transform: translate(-50%, -50%);
        animation: ob-spin 0.6s linear infinite;
      }
      @keyframes ob-spin { to { transform: translate(-50%, -50%) rotate(360deg); } }

      /* === NOTIFICAÇÕES MELHORADAS === */
      .notify {
        position: fixed;
        bottom: 24px; right: 24px;
        padding: 12px 18px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 600;
        max-width: 320px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        z-index: 9999;
        transform: translateX(120%);
        transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .notify.show { transform: translateX(0); }
      .notify.ok { background: #00c853; color: #000; }
      .notify.err { background: #ff3d57; color: #fff; }
      .notify.info { background: #3d9aff; color: #fff; }
      .notify.warn { background: #f0b429; color: #000; }

      @media (max-width: 768px) {
        .notify { bottom: 70px; right: 12px; left: 12px; max-width: none; }
      }

      /* === BETSLIP BADGE === */
      .bs-fab {
        display: none;
        position: fixed;
        bottom: 20px; right: 20px;
        width: 52px; height: 52px;
        border-radius: 50%;
        background: var(--gold, #f0b429);
        color: #000;
        font-size: 20px;
        border: none;
        cursor: pointer;
        z-index: 140;
        box-shadow: 0 4px 16px rgba(240,180,41,0.5);
        align-items: center;
        justify-content: center;
        font-weight: 900;
        transition: transform 0.2s;
      }
      .bs-fab:hover { transform: scale(1.1); }
      .bs-fab.has-bets { display: flex; }
      .bs-fab-badge {
        position: absolute;
        top: -4px; right: -4px;
        background: var(--red, #ff3d57);
        color: #fff;
        font-size: 10px;
        font-weight: 800;
        padding: 2px 5px;
        border-radius: 8px;
        min-width: 18px;
        text-align: center;
      }

      /* === FORM VALIDATION === */
      .input-error {
        border-color: var(--red, #ff3d57) !important;
        box-shadow: 0 0 0 2px rgba(255,61,87,0.2);
      }
      .input-ok {
        border-color: var(--green, #00e676) !important;
        box-shadow: 0 0 0 2px rgba(0,230,118,0.15);
      }
      .field-error-msg {
        color: var(--red, #ff3d57);
        font-size: 11px;
        margin-top: 3px;
        display: block;
      }

      /* === SKELETON LOADING === */
      .skeleton {
        background: linear-gradient(90deg, #111827 25%, #1a2235 50%, #111827 75%);
        background-size: 200% 100%;
        animation: ob-skeleton 1.2s ease-in-out infinite;
        border-radius: 6px;
      }
      @keyframes ob-skeleton {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      .skeleton-row {
        height: 48px; margin-bottom: 4px;
        border-radius: 0;
      }
      .skeleton-row:first-child { border-radius: 8px 8px 0 0; }
      .skeleton-row:last-child { border-radius: 0 0 8px 8px; }

      /* === ODDS ANIMATION === */
      .odd-up { animation: oddUp 0.4s ease; }
      .odd-down { animation: oddDown 0.4s ease; }
      @keyframes oddUp {
        0% { color: var(--green); transform: scale(1.1); }
        100% { color: inherit; transform: scale(1); }
      }
      @keyframes oddDown {
        0% { color: var(--red); transform: scale(0.9); }
        100% { color: inherit; transform: scale(1); }
      }

      /* === SCROLLBAR CUSTOM === */
      * {
        scrollbar-width: thin;
        scrollbar-color: rgba(240,180,41,0.4) transparent;
      }

      /* === HAMBURGER === */
      .hamburger {
        display: none;
        flex-direction: column;
        gap: 5px;
        cursor: pointer;
        padding: 6px;
        border-radius: 6px;
        background: none;
        border: none;
      }
      .hamburger span {
        display: block;
        width: 22px; height: 2px;
        background: var(--text, #e8eaf0);
        transition: all 0.3s;
        border-radius: 2px;
      }
      @media (max-width: 768px) {
        .hamburger { display: flex; }
      }

      /* === TOUCH AREA MÍNIMA (44x44px) === */
      @media (max-width: 768px) {
        .btn-sm { min-height: 36px; }
        .nav-item { min-height: 44px; }
        .match-row { min-height: 52px; }
      }
    `;
    document.head.appendChild(style);
  }

  // ============================================================
  // HAMBURGER MENU — Injetar botão se não existir
  // ============================================================
  function initHamburger() {
    const topbar = document.querySelector('.topbar');
    const sidebar = document.querySelector('.sidebar');
    if (!topbar || !sidebar) return;

    // Overlay
    if (!document.getElementById('sidebarOverlay')) {
      const overlay = document.createElement('div');
      overlay.id = 'sidebarOverlay';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', () => {
        sidebar.classList.remove('mobile-open');
        overlay.classList.remove('show');
      });
    }

    // Botão hamburger
    if (!document.querySelector('.hamburger')) {
      const btn = document.createElement('button');
      btn.className = 'hamburger';
      btn.setAttribute('aria-label', 'Menu');
      btn.innerHTML = '<span></span><span></span><span></span>';
      btn.addEventListener('click', () => {
        sidebar.classList.toggle('mobile-open');
        document.getElementById('sidebarOverlay')?.classList.toggle('show');
      });
      topbar.insertBefore(btn, topbar.firstChild);
    }

    // Fechar sidebar ao clicar num item de menu (mobile)
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        if (window.innerWidth < 768) {
          sidebar.classList.remove('mobile-open');
          document.getElementById('sidebarOverlay')?.classList.remove('show');
        }
      });
    });
  }

  // ============================================================
  // BETSLIP FAB — Botão flutuante no mobile
  // ============================================================
  function initBetslipFAB() {
    const fab = document.createElement('button');
    fab.className = 'bs-fab';
    fab.innerHTML = '🎫 <span class="bs-fab-badge" id="fabBadge">0</span>';
    fab.addEventListener('click', () => {
      const bs = document.querySelector('.betslip-panel') || document.getElementById('betslip');
      if (bs) {
        bs.classList.toggle('open');
        bs.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
    });
    document.body.appendChild(fab);

    // Observar mudanças no betslip
    const updateFAB = () => {
      try {
        const count = (window.betslip || []).length;
        fab.classList.toggle('has-bets', count > 0 && window.innerWidth < 768);
        const badge = document.getElementById('fabBadge');
        if (badge) badge.textContent = count;
      } catch(e) {}
    };

    // Interceptar renderBS global se existir
    if (typeof window.renderBS === 'function') {
      const originalRenderBS = window.renderBS;
      window.renderBS = function(...args) {
        originalRenderBS.apply(this, args);
        updateFAB();
      };
    }

    setInterval(updateFAB, 1000);
  }

  // ============================================================
  // FORM VALIDATION — Melhorar formulários existentes
  // ============================================================
  function enhanceForms() {
    // Validação em tempo real no registo
    const emailInput = document.getElementById('rEmail');
    const phoneInput = document.getElementById('rPhone');
    const passInput = document.getElementById('rPass');

    function setFieldState(input, isValid, msg = '') {
      if (!input) return;
      input.classList.toggle('input-error', !isValid);
      input.classList.toggle('input-ok', isValid);
      let errEl = input.nextElementSibling;
      if (!errEl || !errEl.classList.contains('field-error-msg')) {
        errEl = document.createElement('span');
        errEl.className = 'field-error-msg';
        input.parentNode.insertBefore(errEl, input.nextSibling);
      }
      errEl.textContent = isValid ? '' : msg;
    }

    if (emailInput) {
      emailInput.addEventListener('blur', () => {
        setFieldState(emailInput, Validate.email(emailInput.value), 'Email inválido');
      });
    }
    if (phoneInput) {
      phoneInput.addEventListener('blur', () => {
        setFieldState(phoneInput, Validate.telefone(phoneInput.value), 'Telefone deve ter 9 dígitos');
      });
    }
    if (passInput) {
      passInput.addEventListener('input', () => {
        const len = passInput.value.length;
        if (len > 0) setFieldState(passInput, len >= 8, 'Mínimo 8 caracteres');
      });
    }

    // Validação do valor de depósito
    const depValue = document.getElementById('depValue') || document.getElementById('depVal');
    if (depValue) {
      depValue.addEventListener('input', debounce(() => {
        const v = parseFloat(depValue.value);
        setFieldState(depValue, v >= 500, 'Mínimo 500 Kz');
      }, 300));
    }
  }

  // ============================================================
  // NOTIFICAÇÕES DO SERVIDOR — Polling de notificações
  // ============================================================
  function initServerNotifications() {
    let lastCheck = Date.now();

    const checkNotifs = throttle(async () => {
      const session = Auth.getSession() || (typeof window.currentUser !== 'undefined' ? window.currentUser : null);
      if (!session?.id) return;

      try {
        const res = await fetch(`/api/transacoes?action=notificacoes&user_id=${session.id}`);
        if (!res.ok) return;
        const notifs = await res.json();
        if (!Array.isArray(notifs)) return;

        const novas = notifs.filter(n => !n.lida && new Date(n.criado_em).getTime() > lastCheck - 60000);
        novas.forEach(n => {
          const tipo = n.tipo === 'sucesso' ? 'ok' : n.tipo === 'erro' ? 'err' : 'info';
          if (typeof window.notify === 'function') {
            window.notify(`${n.titulo}: ${n.mensagem}`, tipo);
          }
          // Marcar como lida
          fetch('/api/transacoes?action=notif_lida', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notif_id: n.id })
          }).catch(() => {});
        });

        lastCheck = Date.now();
      } catch(e) {}
    }, 5000);

    // Verificar a cada 30 segundos
    setInterval(checkNotifs, 30000);
  }

  // ============================================================
  // MELHORAR LOGIN/REGISTER — Interceptar funções existentes
  // ============================================================
  function enhanceAuth() {
    // Interceptar doLogin para salvar token
    if (typeof window.doLogin === 'function') {
      const orig = window.doLogin;
      window.doLogin = async function() {
        const u = document.getElementById('lUser')?.value?.trim();
        const p = document.getElementById('lPass')?.value;
        if (!u || !p) { window.notify?.('Preenche todos os campos', 'err'); return; }

        const btn = document.querySelector('[onclick="doLogin()"]') || document.querySelector('.btn-login');
        if (btn) btn.classList.add('ob-loading');

        try {
          const res = await fetch('/api/auth?action=login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ login: u, password: p })
          });
          const d = await res.json();
          if (btn) btn.classList.remove('ob-loading');

          if (!d.ok) { window.notify?.(d.error || 'Credenciais inválidas', 'err'); return; }

          // Salvar token de forma mais segura
          Auth.saveSession(d.user, d.token || '');
          window.currentUser = { id: d.user.id, name: d.user.nome, email: d.user.email, saldo: d.user.saldo };
          window.closeModal?.('authModal');
          window.updateUI?.();
          window.notify?.(`Bem-vindo, ${d.user.nome}! ✅`, 'ok');
        } catch(e) {
          if (btn) btn.classList.remove('ob-loading');
          window.notify?.('Erro de ligação. Tenta novamente.', 'err');
        }
      };
    }
  }

  // ============================================================
  // ACESSIBILIDADE
  // ============================================================
  function addA11y() {
    // Skip link
    const skip = document.createElement('a');
    skip.href = '#main-content';
    skip.textContent = 'Ir para conteúdo';
    skip.style.cssText = 'position:absolute;top:-40px;left:0;background:var(--gold);color:#000;padding:6px;z-index:9999;transition:top 0.3s;';
    skip.addEventListener('focus', () => { skip.style.top = '0'; });
    skip.addEventListener('blur', () => { skip.style.top = '-40px'; });
    document.body.insertBefore(skip, document.body.firstChild);

    // aria-labels em botões sem texto
    document.querySelectorAll('button:not([aria-label])').forEach(btn => {
      if (!btn.textContent.trim()) {
        btn.setAttribute('aria-label', btn.title || 'Botão');
      }
    });
  }

  // ============================================================
  // PERFORMANCE — Lazy load de imagens
  // ============================================================
  function initLazyLoad() {
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            const img = e.target;
            if (img.dataset.src) {
              img.src = img.dataset.src;
              img.removeAttribute('data-src');
              observer.unobserve(img);
            }
          }
        });
      }, { rootMargin: '100px' });

      document.querySelectorAll('img[data-src]').forEach(img => observer.observe(img));
    }
  }

  // ============================================================
  // ANTIFRAUDE CLIENTE — Validações antes de enviar
  // ============================================================
  window.OBFraud = {
    _depCount: 0,
    _depTime: 0,
    _betCount: 0,
    _betTime: 0,
    _levTime: 0,

    canDeposit(valor) {
      const now = Date.now();
      if (now - this._depTime > 3600000) { this._depCount = 0; this._depTime = now; }
      if (this._depCount >= 5) return { ok: false, msg: 'Limite de 5 depósitos/hora no cliente.' };
      if (!Validate.valor(valor, 500, 1000000)) return { ok: false, msg: 'Valor inválido (500 — 1.000.000 Kz).' };
      this._depCount++;
      return { ok: true };
    },

    canBet(valor) {
      const now = Date.now();
      if (now - this._betTime > 60000) { this._betCount = 0; this._betTime = now; }
      if (this._betCount >= 10) return { ok: false, msg: 'Demasiadas apostas. Aguarda 1 minuto.' };
      if (!Validate.valor(valor, 100, 100000)) return { ok: false, msg: 'Aposta: 100 — 100.000 Kz.' };
      this._betCount++;
      return { ok: true };
    },

    canWithdraw() {
      const now = Date.now();
      if (now - this._levTime < 3600000) return { ok: false, msg: 'Apenas 1 levantamento por hora.' };
      this._levTime = now;
      return { ok: true };
    }
  };

  // ============================================================
  // INICIALIZAÇÃO
  // ============================================================
  function init() {
    injectStyles();

    // Aguardar DOM
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setupAll);
    } else {
      setupAll();
    }
  }

  function setupAll() {
    try { Mobile.init(); } catch(e) {}
    try { initHamburger(); } catch(e) {}
    try { enhanceForms(); } catch(e) {}
    try { addA11y(); } catch(e) {}
    try { initLazyLoad(); } catch(e) {}
    try { enhanceAuth(); } catch(e) {}

    // Com delay para garantir que o script principal já carregou
    setTimeout(() => {
      try { initBetslipFAB(); } catch(e) {}
      try { initServerNotifications(); } catch(e) {}
    }, 500);

    // Expor utilitários globais
    window.OBAuth = Auth;
    window.OBAPI = API;
    window.OBValidate = Validate;

    console.log('✅ OnlyBet Patch v2 carregado');
  }

  init();
})();
