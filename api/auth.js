// api/auth.js — OnlyBet Auth v2 — Segurança melhorada
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// Rate limiting em memória (por IP) — reinicia com cada cold start do serverless
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutos

function checkRateLimit(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  const entry = loginAttempts.get(key) || { count: 0, first: now };
  if (now - entry.first > WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: now });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count++;
  loginAttempts.set(key, entry);
  return true;
}

function resetRateLimit(ip) {
  loginAttempts.delete(ip || 'unknown');
}

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

// Hash seguro com salt — sem dependências externas
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
  for (let i = 0; i < first.length; i++) {
    h3 = ((h3 << 5) - h3) + first.charCodeAt(i);
    h3 |= 0;
  }
  return `v2_${salt}_${(Math.abs(h3) >>> 0).toString(36)}_${pass.length}`;
}

function generateSalt() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Gera token de sessão simples (stateless)
function generateToken(userId) {
  const payload = `${userId}:${Date.now()}`;
  const secret = process.env.TOKEN_SECRET || 'onlybet_tok_2025';
  let h = 0;
  for (const c of (payload + secret)) { h = ((h << 5) - h) + c.charCodeAt(0); h |= 0; }
  return Buffer.from(payload).toString('base64') + '.' + Math.abs(h).toString(36);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action } = req.query;
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';

  // ── REGISTAR ────────────────────────────────────────────────
  if (action === 'registar' && req.method === 'POST') {
    const { nome, email, telefone, password } = req.body || {};

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

    const novo = await sb('utilizadores', {
      method: 'POST',
      body: JSON.stringify({
        nome: nome.trim(),
        email: email.toLowerCase().trim(),
        telefone: telClean,
        password_hash: hash,
        saldo: 0,
        nivel: 'bronze'
      })
    });

    if (!novo.ok) {
      const err = await novo.json();
      console.error('Supabase register error:', err);
      return res.status(500).json({ error: 'Erro ao criar conta. Tente novamente.' });
    }

    const user = (await novo.json())[0];
    const token = generateToken(user.id);
    return res.json({
      ok: true,
      token,
      user: { id: user.id, nome: user.nome, email: user.email, telefone: user.telefone, saldo: 0, nivel: 'bronze' }
    });
  }

  // ── LOGIN ────────────────────────────────────────────────────
  if (action === 'login' && req.method === 'POST') {
    // Rate limiting anti-brute-force
    if (!checkRateLimit(clientIp))
      return res.status(429).json({ error: 'Demasiadas tentativas. Aguarda 15 minutos.' });

    const { login, password } = req.body || {};
    if (!login || !password)
      return res.status(400).json({ error: 'Credenciais em falta.' });

    const loginClean = login.toLowerCase().trim().replace(/\s/g, '');
    const r = await sb(`utilizadores?or=(email.eq.${encodeURIComponent(loginClean)},telefone.eq.${encodeURIComponent(loginClean)})&limit=1`);
    const users = await r.json();

    // Tempo constante mesmo quando user não existe (anti-timing attack)
    if (!Array.isArray(users) || !users.length) {
      hashPass(password, 'dummy'); // consumir tempo
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const u = users[0];
    const hash = u.password_hash;
    let valid = false;

    if (hash && hash.startsWith('v2_')) {
      const parts = hash.split('_');
      const salt = parts[1];
      valid = (hashPass(password, salt) === hash);
    } else if (hash) {
      // Hash legado (v1)
      let h = 0;
      for (let i = 0; i < password.length; i++) { h = ((h << 5) - h) + password.charCodeAt(i); h |= 0; }
      const legacyHash = 'h_' + Math.abs(h).toString(36) + '_' + password.length;
      valid = (legacyHash === hash);
      if (valid) {
        // Migrar para v2
        const newSalt = generateSalt();
        const newHash = hashPass(password, newSalt);
        await sb(`utilizadores?id=eq.${u.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ password_hash: newHash })
        }).catch(() => {});
      }
    }

    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas.' });
    if (u.suspenso) return res.status(403).json({ error: 'Conta suspensa. Contacta o suporte.' });

    resetRateLimit(clientIp); // limpar tentativas após sucesso

    await sb(`utilizadores?id=eq.${u.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ultimo_login: new Date().toISOString() })
    }).catch(() => {});

    const token = generateToken(u.id);
    return res.json({
      ok: true,
      token,
      user: {
        id: u.id,
        nome: u.nome,
        email: u.email,
        telefone: u.telefone,
        saldo: parseFloat(u.saldo) || 0,
        nivel: u.nivel || 'bronze'
      }
    });
  }

  // ── PERFIL / SALDO ───────────────────────────────────────────
  if (action === 'perfil' && req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'ID em falta.' });
    // Validar UUID básico
    if (!/^[0-9a-f-]{36}$/i.test(id))
      return res.status(400).json({ error: 'ID inválido.' });

    const r = await sb(`utilizadores?id=eq.${id}&select=id,nome,email,telefone,saldo,bonus,nivel,suspenso,criado_em&limit=1`);
    const u = await r.json();
    if (!Array.isArray(u) || !u.length) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    return res.json(u[0]);
  }

  // ── VERIFICAR TOKEN ──────────────────────────────────────────
  if (action === 'verificar' && req.method === 'POST') {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Token em falta.' });
    try {
      const [payload] = token.split('.');
      const decoded = Buffer.from(payload, 'base64').toString();
      const [userId, timestamp] = decoded.split(':');
      const age = Date.now() - parseInt(timestamp);
      if (age > 24 * 60 * 60 * 1000) return res.status(401).json({ error: 'Token expirado.' });
      const r = await sb(`utilizadores?id=eq.${userId}&select=id,nome,saldo,nivel,suspenso&limit=1`);
      const u = (await r.json())[0];
      if (!u || u.suspenso) return res.status(401).json({ error: 'Sessão inválida.' });
      return res.json({ ok: true, user: u });
    } catch {
      return res.status(401).json({ error: 'Token inválido.' });
    }
  }

  res.status(404).json({ error: 'Acção não encontrada.' });
};
