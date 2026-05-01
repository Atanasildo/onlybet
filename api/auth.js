// api/auth.js — Registo, Login, Perfil via Supabase
// SEGURANÇA: Todas as chaves vêm de variáveis de ambiente do Vercel
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERRO: Variáveis de ambiente SUPABASE_URL e SUPABASE_SECRET são obrigatórias.');
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

// Hash mais seguro usando múltiplas rondas e salt
// Em produção ideal: usar bcrypt com @node-bcrypt
function hashPass(pass, salt = '') {
  const input = salt + pass + 'onlybet_salt_2025';
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = ((h1 << 5) + h1) ^ c;
    h2 = ((h2 << 5) + h2) ^ c;
  }
  // Segunda passagem para mais entropia
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action } = req.query;

  // ── REGISTAR ────────────────────────────────────────────────
  if (action === 'registar' && req.method === 'POST') {
    const { nome, email, telefone, password } = req.body;

    // Validações
    if (!nome || !email || !telefone || !password)
      return res.status(400).json({ error: 'Campos obrigatórios em falta.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Palavra-passe: mínimo 8 caracteres.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Email inválido.' });
    if (!/^\d{9}$/.test(telefone.replace(/\s/g, '')))
      return res.status(400).json({ error: 'Telefone deve ter 9 dígitos.' });

    // Verificar duplicado
    const check = await sb(`utilizadores?or=(email.eq.${encodeURIComponent(email)},telefone.eq.${encodeURIComponent(telefone.replace(/\s/g,''))})&limit=1`);
    const existing = await check.json();
    if (existing.length > 0)
      return res.status(409).json({ error: 'Email ou telefone já registado.' });

    const salt = generateSalt();
    const hash = hashPass(password, salt);

    const novo = await sb('utilizadores', {
      method: 'POST',
      body: JSON.stringify({
        nome: nome.trim(),
        email: email.toLowerCase().trim(),
        telefone: telefone.replace(/\s/g, ''),
        password_hash: hash
      })
    });

    if (!novo.ok) {
      const err = await novo.json();
      console.error('Supabase error:', err);
      return res.status(500).json({ error: 'Erro ao criar conta. Tente novamente.' });
    }

    const user = (await novo.json())[0];
    return res.json({
      ok: true,
      user: { id: user.id, nome: user.nome, email: user.email, telefone: user.telefone, saldo: 0 }
    });
  }

  // ── LOGIN ────────────────────────────────────────────────────
  if (action === 'login' && req.method === 'POST') {
    const { login, password } = req.body;
    if (!login || !password)
      return res.status(400).json({ error: 'Credenciais em falta.' });

    const r = await sb(`utilizadores?or=(email.eq.${encodeURIComponent(login.toLowerCase())},telefone.eq.${encodeURIComponent(login.replace(/\s/g,''))})&limit=1`);
    const users = await r.json();
    if (!users.length) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const u = users[0];
    const hash = u.password_hash;

    // Suporte para hashes antigos (v1) e novos (v2)
    let valid = false;
    if (hash.startsWith('v2_')) {
      const parts = hash.split('_');
      const salt = parts[1];
      valid = (hashPass(password, salt) === hash);
    } else {
      // Hash legado (formato antigo) — verificação compatível
      let h = 0;
      for (let i = 0; i < password.length; i++) { h = ((h << 5) - h) + password.charCodeAt(i); h |= 0; }
      const legacyHash = 'h_' + Math.abs(h).toString(36) + '_' + password.length;
      valid = (legacyHash === hash);

      // Actualizar para hash mais seguro automaticamente
      if (valid) {
        const newSalt = generateSalt();
        const newHash = hashPass(password, newSalt);
        await sb(`utilizadores?id=eq.${u.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ password_hash: newHash })
        });
      }
    }

    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas.' });
    if (u.suspenso) return res.status(403).json({ error: 'Conta suspensa. Contacta o suporte.' });

    await sb(`utilizadores?id=eq.${u.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ultimo_login: new Date().toISOString() })
    });

    return res.json({
      ok: true,
      user: {
        id: u.id,
        nome: u.nome,
        email: u.email,
        telefone: u.telefone,
        saldo: parseFloat(u.saldo) || 0,
        nivel: u.nivel
      }
    });
  }

  // ── PERFIL / SALDO ───────────────────────────────────────────
  if (action === 'perfil' && req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'ID em falta.' });

    const r = await sb(`utilizadores?id=eq.${id}&select=id,nome,email,telefone,saldo,bonus,nivel,suspenso,criado_em&limit=1`);
    const u = await r.json();
    if (!u.length) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    return res.json(u[0]);
  }

  res.status(404).json({ error: 'Acção não encontrada.' });
};