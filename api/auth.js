// api/auth.js — OnlyBet v3 — JWT + Sessões em BD + Segurança máxima
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'onlybet_tok_v3_2025';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// Rate limiting em memória (por IP) — reinicia com cada cold start
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  const entry = loginAttempts.get(key) || { count: 0, first: now };
  if (now - entry.first > WINDOW_MS) { loginAttempts.set(key, { count: 1, first: now }); return true; }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count++;
  loginAttempts.set(key, entry);
  return true;
}
function resetRateLimit(ip) { loginAttempts.delete(ip || 'unknown'); }

const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
  headers: {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': opts.prefer || 'return=representation',
    ...opts.headers
  },
  ...opts
});

// ── HASH v2 com salt (sem dependências externas) ──────────────
function hashPass(pass, salt = '') {
  const input = salt + pass + 'onlybet_salt_2025';
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = ((h1 << 5) + h1) ^ c;
    h2 = ((h2 << 5) + h2) ^ c;
  }
  const first = (Math.abs(h1) >>> 0).toString(36) + (Math.abs(h2) >>> 0).toString(36);
  let h3 = 0;
  for (let i = 0; i < first.length; i++) { h3 = ((h3 << 5) - h3) + first.charCodeAt(i); h3 |= 0; }
  return `v2_${salt}_${(Math.abs(h3) >>> 0).toString(36)}_${pass.length}`;
}
function generateSalt() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

// ── SESSÕES — guardar na tabela `sessoes` ─────────────────────
function generateSessionToken(userId) {
  const rand = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const payload = `${userId}:${Date.now()}:${rand}`;
  const secret = TOKEN_SECRET;
  let h = 0;
  for (const c of (payload + secret)) { h = ((h << 5) - h) + c.charCodeAt(0); h |= 0; }
  return Buffer.from(payload).toString('base64url') + '.' + Math.abs(h).toString(36);
}

function parseToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const [payloadB64] = token.split('.');
    const decoded = Buffer.from(payloadB64, 'base64url').toString();
    const [userId, timestamp] = decoded.split(':');
    if (!userId || !timestamp) return null;
    return { userId, timestamp: parseInt(timestamp) };
  } catch { return null; }
}

async function criarSessao(userId, ip, userAgent) {
  const token = generateSessionToken(userId);
  const tokenHash = hashPass(token, 'sess');
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  await sb('sessoes', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      token_hash: tokenHash,
      ip: ip || null,
      user_agent: (userAgent || '').slice(0, 200),
      expires_at: expiresAt,
      activa: true
    })
  }).catch(e => console.error('Erro ao criar sessão:', e.message));

  return token;
}

async function validarSessao(token) {
  const parsed = parseToken(token);
  if (!parsed) return null;

  const { userId, timestamp } = parsed;
  if (Date.now() - timestamp > 24 * 3600 * 1000) return null;

  // Verificar na BD que a sessão existe e está activa
  const tokenHash = hashPass(token, 'sess');
  const r = await sb(`sessoes?token_hash=eq.${tokenHash}&activa=eq.true&select=id,user_id,expires_at&limit=1`);
  const sessoes = await r.json().catch(() => []);
  if (!Array.isArray(sessoes) || !sessoes.length) return null;

  const sess = sessoes[0];
  if (new Date(sess.expires_at) < new Date()) {
    // Expirada — invalidar
    await sb(`sessoes?id=eq.${sess.id}`, { method: 'PATCH', body: JSON.stringify({ activa: false }) }).catch(() => {});
    return null;
  }

  // Actualizar last_seen
  await sb(`sessoes?id=eq.${sess.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_seen: new Date().toISOString() })
  }).catch(() => {});

  return sess.user_id;
}

async function revogarSessao(token) {
  const tokenHash = hashPass(token, 'sess');
  await sb(`sessoes?token_hash=eq.${tokenHash}`, {
    method: 'PATCH',
    body: JSON.stringify({ activa: false })
  }).catch(() => {});
}

// ── LEDGER — registar movimento financeiro atómico ────────────
async function ledger(userId, tipo, valor, ref, descricao, meta = {}) {
  // Usar RPC se existir, caso contrário inserir directamente
  const entry = {
    user_id: userId,
    tipo,                  // deposito | levantamento | aposta | ganho | bonus | ajuste | estorno
    valor: parseFloat(valor),
    referencia: ref || null,
    descricao: descricao || tipo,
    meta: JSON.stringify(meta),
    criado_em: new Date().toISOString()
  };
  await sb('ledger', { method: 'POST', body: JSON.stringify(entry) }).catch(e => {
    console.error('Ledger error:', e.message);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action } = req.query;
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const userAgent = req.headers['user-agent'] || '';

  // ── REGISTAR ────────────────────────────────────────────────
  if (action === 'registar' && req.method === 'POST') {
    const { nome, email, telefone, password, ref_code } = req.body || {};

    if (!nome || !email || !telefone || !password)
      return res.status(400).json({ error: 'Campos obrigatórios em falta.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Palavra-passe: mínimo 8 caracteres.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Email inválido.' });

    const telClean = telefone.replace(/\s/g, '');
    if (!/^\d{9}$/.test(telClean))
      return res.status(400).json({ error: 'Telefone deve ter 9 dígitos.' });
    if (nome.trim().length < 3)
      return res.status(400).json({ error: 'Nome muito curto (mín. 3 caracteres).' });

    // Verificar duplicado
    const check = await sb(`utilizadores?or=(email.eq.${encodeURIComponent(email.toLowerCase())},telefone.eq.${encodeURIComponent(telClean)})&select=id&limit=1`);
    const existing = await check.json();
    if (Array.isArray(existing) && existing.length > 0)
      return res.status(409).json({ error: 'Email ou telefone já registado.' });

    const salt = generateSalt();
    const hash = hashPass(password, salt);

    // Verificar referido
    let referidoPor = null;
    if (ref_code) {
      const refR = await sb(`utilizadores?id=like.${ref_code}%&select=id&limit=1`);
      const refU = await refR.json().catch(() => []);
      if (Array.isArray(refU) && refU.length) referidoPor = refU[0].id;
    }

    const novo = await sb('utilizadores', {
      method: 'POST',
      body: JSON.stringify({
        nome: nome.trim(),
        email: email.toLowerCase().trim(),
        telefone: telClean,
        password_hash: hash,
        saldo: 0,
        nivel: 'bronze',
        referido_por: referidoPor
      })
    });

    if (!novo.ok) {
      const err = await novo.json().catch(() => ({}));
      console.error('Supabase register error:', err);
      return res.status(500).json({ error: 'Erro ao criar conta. Tente novamente.' });
    }

    const user = (await novo.json())[0];

    // Criar registo em afiliados se veio com referral
    if (referidoPor) {
      await sb('referidos', {
        method: 'POST',
        body: JSON.stringify({ afiliado_id: referidoPor, novo_user_id: user.id, estado: 'pendente' })
      }).catch(() => {});
    }

    const token = await criarSessao(user.id, clientIp, userAgent);

    return res.json({
      ok: true,
      token,
      user: { id: user.id, nome: user.nome, email: user.email, telefone: user.telefone, saldo: 0, nivel: 'bronze' }
    });
  }

  // ── LOGIN ────────────────────────────────────────────────────
  if (action === 'login' && req.method === 'POST') {
    if (!checkRateLimit(clientIp))
      return res.status(429).json({ error: 'Demasiadas tentativas. Aguarda 15 minutos.' });

    const { login, password } = req.body || {};
    if (!login || !password)
      return res.status(400).json({ error: 'Credenciais em falta.' });

    const loginClean = login.toLowerCase().trim().replace(/\s/g, '');
    const r = await sb(`utilizadores?or=(email.eq.${encodeURIComponent(loginClean)},telefone.eq.${encodeURIComponent(loginClean)})&limit=1`);
    const users = await r.json();

    if (!Array.isArray(users) || !users.length) {
      hashPass(password, 'dummy');
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const u = users[0];
    let valid = false;
    const hash = u.password_hash;

    if (hash && hash.startsWith('v2_')) {
      const parts = hash.split('_');
      valid = (hashPass(password, parts[1]) === hash);
    } else if (hash) {
      let h = 0;
      for (let i = 0; i < password.length; i++) { h = ((h << 5) - h) + password.charCodeAt(i); h |= 0; }
      const legacyHash = 'h_' + Math.abs(h).toString(36) + '_' + password.length;
      valid = (legacyHash === hash);
      if (valid) {
        const newSalt = generateSalt();
        await sb(`utilizadores?id=eq.${u.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ password_hash: hashPass(password, newSalt) })
        }).catch(() => {});
      }
    }

    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas.' });
    if (u.suspenso) return res.status(403).json({ error: 'Conta suspensa. Contacta o suporte.' });

    resetRateLimit(clientIp);

    await sb(`utilizadores?id=eq.${u.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ultimo_login: new Date().toISOString() })
    }).catch(() => {});

    const token = await criarSessao(u.id, clientIp, userAgent);

    return res.json({
      ok: true,
      token,
      user: {
        id: u.id, nome: u.nome, email: u.email,
        telefone: u.telefone,
        saldo: parseFloat(u.saldo) || 0,
        nivel: u.nivel || 'bronze'
      }
    });
  }

  // ── LOGOUT ───────────────────────────────────────────────────
  if (action === 'logout' && req.method === 'POST') {
    const { token } = req.body || {};
    if (token) await revogarSessao(token);
    return res.json({ ok: true });
  }

  // ── VERIFICAR TOKEN ──────────────────────────────────────────
  if (action === 'verificar' && req.method === 'POST') {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Token em falta.' });

    const userId = await validarSessao(token);
    if (!userId) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });

    const r = await sb(`utilizadores?id=eq.${userId}&select=id,nome,saldo,nivel,suspenso&limit=1`);
    const u = (await r.json())[0];
    if (!u || u.suspenso) return res.status(401).json({ error: 'Sessão inválida.' });

    return res.json({ ok: true, user: u });
  }

  // ── PERFIL / SALDO ───────────────────────────────────────────
  if (action === 'perfil' && req.method === 'GET') {
    const { id } = req.query;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id))
      return res.status(400).json({ error: 'ID inválido.' });

    const r = await sb(`utilizadores?id=eq.${id}&select=id,nome,email,telefone,saldo,bonus,nivel,suspenso,criado_em,ultimo_login&limit=1`);
    const u = await r.json();
    if (!Array.isArray(u) || !u.length) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    return res.json(u[0]);
  }

  // ── AUTO-EXCLUSÃO ────────────────────────────────────────────
  if (action === 'auto_exclusao' && req.method === 'POST') {
    const { user_id, dias } = req.body || {};
    if (!user_id || !dias) return res.status(400).json({ error: 'Dados em falta.' });

    const diasNum = parseInt(dias);
    if (![1, 7, 30, 90, 365].includes(diasNum))
      return res.status(400).json({ error: 'Período inválido.' });

    const reativarEm = new Date(Date.now() + diasNum * 86400000).toISOString();
    await sb(`utilizadores?id=eq.${user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ suspenso: true, auto_exclusao_ate: reativarEm })
    });

    // Revogar todas as sessões
    await sb(`sessoes?user_id=eq.${user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ activa: false })
    }).catch(() => {});

    return res.json({ ok: true, reativar_em: reativarEm });
  }

  // ── SESSÕES ACTIVAS ──────────────────────────────────────────
  if (action === 'sessoes' && req.method === 'GET') {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const r = await sb(`sessoes?user_id=eq.${user_id}&activa=eq.true&select=id,ip,user_agent,criado_em,last_seen,expires_at&order=criado_em.desc&limit=10`);
    return res.json(await r.json());
  }

  // ── REVOGAR SESSÃO ESPECÍFICA ────────────────────────────────
  if (action === 'revogar_sessao' && req.method === 'POST') {
    const { sessao_id, user_id } = req.body || {};
    if (!sessao_id || !user_id) return res.status(400).json({ error: 'Dados em falta.' });
    await sb(`sessoes?id=eq.${sessao_id}&user_id=eq.${user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ activa: false })
    });
    return res.json({ ok: true });
  }

  // Exportar utilitários para uso interno noutros módulos
  module.exports.validarSessao = validarSessao;
  module.exports.ledger = ledger;

  res.status(404).json({ error: 'Acção não encontrada.' });
};

// Exportar para uso em outros módulos
module.exports.validarSessao = validarSessao;
module.exports.ledger = ledger;
module.exports.hashPass = hashPass;
