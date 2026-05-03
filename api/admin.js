// api/admin.js — OnlyBet Admin v3 — BI + KYC + Risco + Ledger + Afiliados
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET;
const ADMIN_PASS = process.env.ADMIN_PASS || 'OnlyBet2025!';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@onlybet.ao';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'onlybet_admin_tok_2025';

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

function createAdminToken(email) {
  const payload = `${email}:${Date.now()}`;
  let h = 0;
  for (const c of (payload + TOKEN_SECRET)) { h = ((h << 5) - h) + c.charCodeAt(0); h |= 0; }
  return Buffer.from(payload).toString('base64') + '.' + Math.abs(h).toString(36);
}

function validateAdminToken(token) {
  if (!token) return false;
  try {
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) return false;
    const payload = Buffer.from(payloadB64, 'base64').toString();
    const [email, timestamp] = payload.split(':');
    if (email !== ADMIN_EMAIL) return false;
    if (Date.now() - parseInt(timestamp) > 12 * 3600 * 1000) return false;
    let h = 0;
    for (const c of (payload + TOKEN_SECRET)) { h = ((h << 5) - h) + c.charCodeAt(0); h |= 0; }
    return sig === Math.abs(h).toString(36);
  } catch { return false; }
}

// Ledger entry para acções admin
async function ledger(userId, tipo, valor, ref, descricao, meta = {}) {
  await sb('ledger', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId, tipo, valor: parseFloat(valor),
      referencia: ref || null, descricao: descricao || tipo,
      meta: typeof meta === 'string' ? meta : JSON.stringify(meta),
      criado_em: new Date().toISOString()
    })
  }).catch(e => console.error('Ledger error:', e.message));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action } = req.query;

  // ── LOGIN ADMIN ──────────────────────────────────────────────
  if (action === 'login' && req.method === 'POST') {
    const { email, password } = req.body || {};
    const isValid = email === ADMIN_EMAIL && password === ADMIN_PASS;
    if (!isValid) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }
    const token = createAdminToken(email);
    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: email, accao: 'Login', detalhe: 'Login no painel admin' })
    }).catch(() => {});
    return res.json({ ok: true, token });
  }

  const token = req.headers['x-admin-token'];
  if (!validateAdminToken(token))
    return res.status(401).json({ error: 'Token inválido ou expirado. Faz login novamente.' });

  // ── DASHBOARD — KPIs principais ──────────────────────────────
  if (action === 'dashboard') {
    const [users, txs, deps, apostas, risco] = await Promise.all([
      sb('utilizadores?select=id,saldo,suspenso,nivel,criado_em').then(r => r.json()).catch(() => []),
      sb('transacoes?select=tipo,valor,estado,criado_em&order=criado_em.desc&limit=500').then(r => r.json()).catch(() => []),
      sb('depositos_pendentes?estado=eq.transferido&select=id').then(r => r.json()).catch(() => []),
      sb('apostas?select=valor_apostado,ganho_real,resultado,criado_em').then(r => r.json()).catch(() => []),
      sb('risco_eventos?estado=eq.pendente&select=id').then(r => r.json()).catch(() => [])
    ]);

    const now = Date.now();
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const semanaAtras = new Date(now - 7 * 86400000);

    const totalBal = Array.isArray(users) ? users.reduce((s, u) => s + parseFloat(u.saldo || 0), 0) : 0;
    const suspensos = Array.isArray(users) ? users.filter(u => u.suspenso).length : 0;
    const novosHoje = Array.isArray(users) ? users.filter(u => new Date(u.criado_em) >= hoje).length : 0;
    const novosSemana = Array.isArray(users) ? users.filter(u => new Date(u.criado_em) >= semanaAtras).length : 0;

    const depAprovados = Array.isArray(txs) ? txs.filter(t => t.tipo === 'deposito' && t.estado === 'aprovado') : [];
    const depTotal = depAprovados.reduce((s, t) => s + parseFloat(t.valor || 0), 0);
    const depHoje = depAprovados.filter(t => new Date(t.criado_em) >= hoje).reduce((s, t) => s + parseFloat(t.valor || 0), 0);

    const levPend = Array.isArray(txs) ? txs.filter(t => t.tipo === 'levantamento' && t.estado === 'pendente') : [];
    const levTotal = levPend.reduce((s, t) => s + parseFloat(t.valor || 0), 0);

    const apostTotal = Array.isArray(apostas) ? apostas.reduce((s, a) => s + parseFloat(a.valor_apostado || 0), 0) : 0;
    const apostHoje = Array.isArray(apostas) ? apostas.filter(a => new Date(a.criado_em) >= hoje).reduce((s, a) => s + parseFloat(a.valor_apostado || 0), 0) : 0;
    const ganhoPago = Array.isArray(apostas) ? apostas.filter(a => a.resultado === 'ganhou').reduce((s, a) => s + parseFloat(a.ganho_real || 0), 0) : 0;
    const ggr = Math.max(0, apostTotal - ganhoPago);
    const apostPend = Array.isArray(apostas) ? apostas.filter(a => a.resultado === 'pendente').length : 0;

    // Distribuição por nível
    const niveis = {};
    if (Array.isArray(users)) users.forEach(u => { niveis[u.nivel || 'bronze'] = (niveis[u.nivel || 'bronze'] || 0) + 1; });

    return res.json({
      total_users: Array.isArray(users) ? users.length : 0,
      users_suspensos: suspensos,
      users_novos_hoje: novosHoje,
      users_novos_semana: novosSemana,
      niveis_distribuicao: niveis,
      saldo_total: totalBal,
      depositos_total: depTotal,
      depositos_hoje: depHoje,
      levantamentos_pendentes: levPend.length,
      levantamentos_valor: levTotal,
      deps_pendentes_confirmados: Array.isArray(deps) ? deps.length : 0,
      apostas_total: Array.isArray(apostas) ? apostas.length : 0,
      apostas_pendentes: apostPend,
      volume_apostado: apostTotal,
      volume_apostado_hoje: apostHoje,
      ganho_pago: ganhoPago,
      ggr,
      hold: apostTotal > 0 ? (ggr / apostTotal * 100).toFixed(1) : '0.0',
      alertas_risco: Array.isArray(risco) ? risco.length : 0
    });
  }

  // ── BI / RELATÓRIO AVANÇADO ──────────────────────────────────
  if (action === 'bi') {
    const { periodo = '7d' } = req.query;
    const dias = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 }[periodo] || 7;
    const desde = new Date(Date.now() - dias * 86400000).toISOString();

    const [txs, apostas, users] = await Promise.all([
      sb(`transacoes?criado_em=gte.${desde}&select=tipo,metodo,valor,estado,criado_em`).then(r => r.json()).catch(() => []),
      sb(`apostas?criado_em=gte.${desde}&select=valor_apostado,ganho_real,resultado,criado_em,jogo`).then(r => r.json()).catch(() => []),
      sb(`utilizadores?criado_em=gte.${desde}&select=id,criado_em,nivel`).then(r => r.json()).catch(() => [])
    ]);

    // Agrupar por dia
    const porDia = {};
    const addDay = (date, field, val) => {
      const d = date.slice(0, 10);
      if (!porDia[d]) porDia[d] = { depositos: 0, levantamentos: 0, apostas: 0, ggr: 0, novos_users: 0, ganho_pago: 0 };
      porDia[d][field] = (porDia[d][field] || 0) + val;
    };

    if (Array.isArray(txs)) {
      txs.forEach(t => {
        if (t.tipo === 'deposito' && t.estado === 'aprovado') addDay(t.criado_em, 'depositos', parseFloat(t.valor || 0));
        if (t.tipo === 'levantamento') addDay(t.criado_em, 'levantamentos', parseFloat(t.valor || 0));
      });
    }

    if (Array.isArray(apostas)) {
      apostas.forEach(a => {
        addDay(a.criado_em, 'apostas', parseFloat(a.valor_apostado || 0));
        if (a.resultado === 'ganhou') addDay(a.criado_em, 'ganho_pago', parseFloat(a.ganho_real || 0));
      });
    }

    if (Array.isArray(users)) {
      users.forEach(u => addDay(u.criado_em, 'novos_users', 1));
    }

    // Calcular GGR por dia
    Object.values(porDia).forEach(d => { d.ggr = Math.max(0, d.apostas - d.ganho_pago); });

    // Top jogos por volume
    const jogosVol = {};
    if (Array.isArray(apostas)) {
      apostas.forEach(a => {
        const j = (a.jogo || 'Desconhecido').slice(0, 40);
        if (!jogosVol[j]) jogosVol[j] = { volume: 0, count: 0 };
        jogosVol[j].volume += parseFloat(a.valor_apostado || 0);
        jogosVol[j].count++;
      });
    }
    const topJogos = Object.entries(jogosVol).sort((a, b) => b[1].volume - a[1].volume).slice(0, 10).map(([jogo, d]) => ({ jogo, ...d }));

    return res.json({ por_dia: porDia, top_jogos: topJogos, periodo_dias: dias });
  }

  // ── LISTAR UTILIZADORES ──────────────────────────────────────
  if (action === 'utilizadores') {
    const { search, suspenso } = req.query;
    let q = 'utilizadores?select=id,nome,email,telefone,saldo,nivel,suspenso,criado_em,ultimo_login&order=criado_em.desc&limit=100';
    if (suspenso === 'true') q += '&suspenso=eq.true';
    if (suspenso === 'false') q += '&suspenso=eq.false';
    const r = await sb(q);
    let data = await r.json().catch(() => []);
    if (search && Array.isArray(data)) {
      const s = search.toLowerCase();
      data = data.filter(u => u.nome?.toLowerCase().includes(s) || u.email?.toLowerCase().includes(s) || u.telefone?.includes(s));
    }
    return res.json(data);
  }

  // ── DETALHE DO UTILIZADOR ─────────────────────────────────────
  if (action === 'user_detalhe') {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const [u, txs, apostas, deps, ledgerData, sessoes, kyc, risco] = await Promise.all([
      sb(`utilizadores?id=eq.${user_id}&limit=1`).then(r => r.json()).catch(() => []),
      sb(`transacoes?user_id=eq.${user_id}&order=criado_em.desc&limit=20`).then(r => r.json()).catch(() => []),
      sb(`apostas?user_id=eq.${user_id}&order=criado_em.desc&limit=20`).then(r => r.json()).catch(() => []),
      sb(`depositos_pendentes?user_id=eq.${user_id}&order=criado_em.desc&limit=10`).then(r => r.json()).catch(() => []),
      sb(`ledger?user_id=eq.${user_id}&order=criado_em.desc&limit=30`).then(r => r.json()).catch(() => []),
      sb(`sessoes?user_id=eq.${user_id}&activa=eq.true&select=id,ip,user_agent,criado_em,last_seen&limit=5`).then(r => r.json()).catch(() => []),
      sb(`kyc?user_id=eq.${user_id}&select=estado,tipo_documento,submetido_em,verificado_em&limit=1`).then(r => r.json()).catch(() => []),
      sb(`risco_eventos?user_id=eq.${user_id}&order=criado_em.desc&limit=10`).then(r => r.json()).catch(() => [])
    ]);
    return res.json({
      user: u[0] || null, transacoes: txs, apostas, depositos: deps,
      ledger: ledgerData, sessoes, kyc: kyc[0] || null, risco_eventos: risco
    });
  }

  // ── SUSPENDER/ACTIVAR UTILIZADOR ────────────────────────────
  if (action === 'toggle_suspend' && req.method === 'PATCH') {
    const { user_id, suspenso } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    await sb(`utilizadores?id=eq.${user_id}`, { method: 'PATCH', body: JSON.stringify({ suspenso: !!suspenso }) });
    // Revogar sessões ao suspender
    if (suspenso) {
      await sb(`sessoes?user_id=eq.${user_id}`, { method: 'PATCH', body: JSON.stringify({ activa: false }) }).catch(() => {});
    }
    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: suspenso ? 'Conta Suspensa' : 'Conta Activada', detalhe: `user_id: ${user_id}` })
    }).catch(() => {});
    return res.json({ ok: true });
  }

  // ── AJUSTAR SALDO ────────────────────────────────────────────
  if (action === 'ajustar_saldo' && req.method === 'PATCH') {
    const { user_id, valor, motivo } = req.body || {};
    if (!user_id || valor === undefined) return res.status(400).json({ error: 'Dados em falta.' });
    const ur = await sb(`utilizadores?id=eq.${user_id}&select=saldo,nome&limit=1`);
    const u = (await ur.json())[0];
    if (!u) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    const valorNum = parseFloat(valor);
    const novo = Math.max(0, parseFloat(u.saldo || 0) + valorNum);
    await sb(`utilizadores?id=eq.${user_id}`, { method: 'PATCH', body: JSON.stringify({ saldo: novo }) });
    await sb('transacoes', {
      method: 'POST',
      body: JSON.stringify({ user_id, tipo: 'ajuste', valor: Math.abs(valorNum), estado: 'aprovado', notas: motivo || 'Ajuste manual admin' })
    });
    await ledger(user_id, 'ajuste', valorNum, null, motivo || 'Ajuste manual admin', { admin: ADMIN_EMAIL });
    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Ajuste Saldo', detalhe: `${u.nome}: ${valorNum > 0 ? '+' : ''}${valorNum} Kz. ${motivo || ''}` })
    }).catch(() => {});
    return res.json({ ok: true, saldo_novo: novo });
  }

  // ── DEPÓSITOS PENDENTES ──────────────────────────────────────
  if (action === 'depositos_pendentes') {
    const r = await sb('depositos_pendentes?estado=eq.transferido&order=criado_em.desc');
    const deps = await r.json().catch(() => []);
    if (!Array.isArray(deps)) return res.json([]);
    const enriched = await Promise.all(deps.slice(0, 50).map(async d => {
      try {
        const ur = await sb(`utilizadores?id=eq.${d.user_id}&select=nome,telefone&limit=1`);
        const u = (await ur.json())[0];
        return { ...d, user_nome: u?.nome || '—', user_telefone: u?.telefone || '—' };
      } catch { return { ...d, user_nome: '—', user_telefone: '—' }; }
    }));
    return res.json(enriched);
  }

  // ── TODOS OS DEPÓSITOS ───────────────────────────────────────
  if (action === 'depositos') {
    const { estado } = req.query;
    let q = 'depositos_pendentes?order=criado_em.desc&limit=100';
    if (estado && estado !== 'all') q += `&estado=eq.${estado}`;
    const r = await sb(q);
    return res.json(await r.json().catch(() => []));
  }

  // ── APROVAR DEPÓSITO ─────────────────────────────────────────
  if (action === 'aprovar_deposito' && req.method === 'POST') {
    const { ref } = req.body || {};
    if (!ref) return res.status(400).json({ error: 'Referência em falta.' });

    const dr = await sb(`depositos_pendentes?referencia=eq.${ref}&limit=1`);
    const dep = (await dr.json())[0];
    if (!dep) return res.status(404).json({ error: 'Depósito não encontrado.' });
    if (dep.estado === 'aprovado') return res.status(409).json({ error: 'Já foi aprovado.' });

    await sb(`depositos_pendentes?referencia=eq.${ref}`, { method: 'PATCH', body: JSON.stringify({ estado: 'aprovado' }) });

    const ur = await sb(`utilizadores?id=eq.${dep.user_id}&select=saldo&limit=1`);
    const u = (await ur.json())[0];
    const novoSaldo = parseFloat(u?.saldo || 0) + parseFloat(dep.valor);
    await sb(`utilizadores?id=eq.${dep.user_id}`, { method: 'PATCH', body: JSON.stringify({ saldo: novoSaldo }) });
    await sb('transacoes', {
      method: 'POST',
      body: JSON.stringify({ user_id: dep.user_id, tipo: 'deposito', metodo: dep.metodo, valor: dep.valor, estado: 'aprovado', referencia: ref })
    });

    // Ledger — creditar depósito
    await ledger(dep.user_id, 'deposito', dep.valor, ref, `Depósito ${dep.metodo} aprovado pelo admin`, { metodo: dep.metodo });

    // Bónus de boas-vindas — verificar se é o 1º depósito
    const depCount = await sb(`transacoes?user_id=eq.${dep.user_id}&tipo=eq.deposito&estado=eq.aprovado&select=id`).then(r => r.json()).catch(() => []);
    if (Array.isArray(depCount) && depCount.length === 1) {
      const bonusVal = Math.min(parseFloat(dep.valor), 50000); // max 50k Kz
      await sb(`utilizadores?id=eq.${dep.user_id}`, { method: 'PATCH', body: JSON.stringify({ bonus: bonusVal }) }).catch(() => {});
      await sb('bonus', {
        method: 'POST',
        body: JSON.stringify({
          user_id: dep.user_id, tipo: 'boas_vindas', valor: bonusVal,
          rollover: 5, rollover_completado: 0, estado: 'activo',
          expires_at: new Date(Date.now() + 30 * 86400000).toISOString()
        })
      }).catch(() => {});
      await ledger(dep.user_id, 'bonus', bonusVal, null, 'Bónus boas-vindas 100% (1º depósito)', { tipo: 'boas_vindas' });
      await sb('notificacoes', {
        method: 'POST',
        body: JSON.stringify({
          user_id: dep.user_id,
          titulo: '🎁 Bónus de Boas-Vindas Activado!',
          mensagem: `Parabéns! Recebeste ${bonusVal.toLocaleString('pt-AO')} Kz de bónus pelo teu 1º depósito. Rollover 5x.`,
          tipo: 'sucesso'
        })
      }).catch(() => {});
    }

    await sb('notificacoes', {
      method: 'POST',
      body: JSON.stringify({
        user_id: dep.user_id,
        titulo: 'Depósito Aprovado! ✅',
        mensagem: `O teu depósito de ${Number(dep.valor).toLocaleString('pt-AO')} Kz foi creditado na tua conta.`,
        tipo: 'sucesso'
      })
    }).catch(() => {});

    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Depósito Aprovado', detalhe: `Ref: ${ref} · ${dep.valor} Kz` })
    }).catch(() => {});

    return res.json({ ok: true, saldo_novo: novoSaldo });
  }

  // ── REJEITAR DEPÓSITO ────────────────────────────────────────
  if (action === 'rejeitar_deposito' && req.method === 'POST') {
    const { ref, motivo } = req.body || {};
    if (!ref) return res.status(400).json({ error: 'Referência em falta.' });
    const dr = await sb(`depositos_pendentes?referencia=eq.${ref}&limit=1`);
    const dep = (await dr.json())[0];
    if (!dep) return res.status(404).json({ error: 'Depósito não encontrado.' });
    await sb(`depositos_pendentes?referencia=eq.${ref}`, { method: 'PATCH', body: JSON.stringify({ estado: 'rejeitado' }) });
    await sb('notificacoes', {
      method: 'POST',
      body: JSON.stringify({
        user_id: dep.user_id,
        titulo: 'Depósito Rejeitado ❌',
        mensagem: `O teu depósito (Ref: ${ref}) foi rejeitado. ${motivo ? 'Motivo: ' + motivo : 'Contacta o suporte.'}`,
        tipo: 'erro'
      })
    }).catch(() => {});
    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Depósito Rejeitado', detalhe: `Ref: ${ref}${motivo ? ' · ' + motivo : ''}` })
    }).catch(() => {});
    return res.json({ ok: true });
  }

  // ── LEVANTAMENTOS ────────────────────────────────────────────
  if (action === 'levantamentos') {
    const r = await sb('transacoes?tipo=eq.levantamento&order=criado_em.desc&limit=100');
    return res.json(await r.json().catch(() => []));
  }

  // ── APROVAR LEVANTAMENTO ─────────────────────────────────────
  if (action === 'aprovar_levantamento' && req.method === 'POST') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID em falta.' });
    const lr = await sb(`transacoes?id=eq.${id}&limit=1`);
    const lev = (await lr.json())[0];
    if (!lev) return res.status(404).json({ error: 'Levantamento não encontrado.' });
    await sb(`transacoes?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ estado: 'aprovado' }) });
    await ledger(lev.user_id, 'levantamento_aprovado', 0, lev.referencia, 'Levantamento aprovado pelo admin', { admin: ADMIN_EMAIL, id });
    await sb('notificacoes', {
      method: 'POST',
      body: JSON.stringify({
        user_id: lev.user_id,
        titulo: 'Levantamento Aprovado ✅',
        mensagem: `O teu levantamento de ${Number(lev.valor).toLocaleString('pt-AO')} Kz foi aprovado e está a ser processado.`,
        tipo: 'sucesso'
      })
    }).catch(() => {});
    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Levantamento Aprovado', detalhe: `id: ${id}` })
    }).catch(() => {});
    return res.json({ ok: true });
  }

  // ── REJEITAR LEVANTAMENTO ────────────────────────────────────
  if (action === 'rejeitar_levantamento' && req.method === 'POST') {
    const { id, motivo } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID em falta.' });
    const lr = await sb(`transacoes?id=eq.${id}&limit=1`);
    const lev = (await lr.json())[0];
    if (!lev) return res.status(404).json({ error: 'Levantamento não encontrado.' });
    if (lev.estado !== 'pendente') return res.status(409).json({ error: 'Já foi processado.' });
    await sb(`transacoes?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ estado: 'rejeitado' }) });
    const ur = await sb(`utilizadores?id=eq.${lev.user_id}&select=saldo&limit=1`);
    const u = (await ur.json())[0];
    const novoSaldo = parseFloat(u?.saldo || 0) + parseFloat(lev.valor);
    await sb(`utilizadores?id=eq.${lev.user_id}`, { method: 'PATCH', body: JSON.stringify({ saldo: novoSaldo }) });
    await ledger(lev.user_id, 'estorno', parseFloat(lev.valor), lev.referencia, `Levantamento rejeitado: ${motivo || 'sem motivo'}`, { admin: ADMIN_EMAIL });
    await sb('notificacoes', {
      method: 'POST',
      body: JSON.stringify({
        user_id: lev.user_id,
        titulo: 'Levantamento Rejeitado',
        mensagem: `O teu levantamento de ${Number(lev.valor).toLocaleString('pt-AO')} Kz foi devolvido ao teu saldo. ${motivo ? 'Motivo: ' + motivo : ''}`,
        tipo: 'erro'
      })
    }).catch(() => {});
    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Levantamento Rejeitado', detalhe: `id: ${id}${motivo ? ' · ' + motivo : ''}` })
    }).catch(() => {});
    return res.json({ ok: true, saldo_devolvido: parseFloat(lev.valor) });
  }

  // ── APOSTAS ──────────────────────────────────────────────────
  if (action === 'apostas') {
    const { estado } = req.query;
    let q = 'apostas?order=criado_em.desc&limit=100';
    if (estado) q += `&resultado=eq.${estado}`;
    const r = await sb(q);
    return res.json(await r.json().catch(() => []));
  }

  // ── RESOLVER APOSTA ──────────────────────────────────────────
  if (action === 'resolver_aposta' && req.method === 'POST') {
    const { id, resultado } = req.body || {};
    if (!id || !['ganhou', 'perdeu', 'cancelada'].includes(resultado))
      return res.status(400).json({ error: 'Dados inválidos.' });

    const ar = await sb(`apostas?id=eq.${id}&limit=1`);
    const aposta = (await ar.json())[0];
    if (!aposta) return res.status(404).json({ error: 'Aposta não encontrada.' });
    if (aposta.resultado !== 'pendente') return res.status(409).json({ error: 'Aposta já foi resolvida.' });

    const ganhoReal = resultado === 'ganhou' ? parseFloat(aposta.ganho_potencial || 0) : 0;
    await sb(`apostas?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ resultado, ganho_real: ganhoReal }) });

    if (resultado === 'ganhou' || resultado === 'cancelada') {
      const valorDevolver = resultado === 'ganhou' ? ganhoReal : parseFloat(aposta.valor_apostado || 0);
      const ur = await sb(`utilizadores?id=eq.${aposta.user_id}&select=saldo&limit=1`);
      const u = (await ur.json())[0];
      const novoSaldo = parseFloat(u?.saldo || 0) + valorDevolver;
      await sb(`utilizadores?id=eq.${aposta.user_id}`, { method: 'PATCH', body: JSON.stringify({ saldo: novoSaldo }) });
      await ledger(aposta.user_id, resultado === 'ganhou' ? 'ganho' : 'estorno', valorDevolver, aposta.referencia,
        resultado === 'ganhou' ? `Aposta ganha: ${aposta.jogo}` : `Aposta cancelada: ${aposta.jogo}`,
        { aposta_id: id, admin: ADMIN_EMAIL }
      );
    }

    const msgs = {
      ganhou: `🎉 Parabéns! A tua aposta em "${aposta.jogo}" ganhou! Recebeste ${ganhoReal.toLocaleString('pt-AO')} Kz.`,
      perdeu: `A tua aposta em "${aposta.jogo}" não foi bem sucedida. Boa sorte na próxima!`,
      cancelada: `ℹ️ A tua aposta em "${aposta.jogo}" foi cancelada. O valor de ${parseFloat(aposta.valor_apostado).toLocaleString('pt-AO')} Kz foi devolvido.`
    };
    await sb('notificacoes', {
      method: 'POST',
      body: JSON.stringify({
        user_id: aposta.user_id,
        titulo: resultado === 'ganhou' ? '🎉 Aposta Ganha!' : resultado === 'cancelada' ? 'ℹ️ Aposta Cancelada' : '❌ Aposta Perdida',
        mensagem: msgs[resultado],
        tipo: resultado === 'ganhou' ? 'sucesso' : resultado === 'cancelada' ? 'info' : 'erro'
      })
    }).catch(() => {});

    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Aposta Resolvida', detalhe: `id: ${id} · ${resultado} · ${ganhoReal} Kz` })
    }).catch(() => {});

    return res.json({ ok: true, resultado, ganho_real: ganhoReal });
  }

  // ── KYC — listar pendentes ───────────────────────────────────
  if (action === 'kyc_pendentes') {
    const r = await sb('kyc?estado=eq.pendente&order=submetido_em.asc&limit=50');
    const kycs = await r.json().catch(() => []);
    const enriched = await Promise.all(kycs.map(async k => {
      const ur = await sb(`utilizadores?id=eq.${k.user_id}&select=nome,email,telefone&limit=1`).then(r => r.json()).catch(() => []);
      return { ...k, ...ur[0] };
    }));
    return res.json(enriched);
  }

  // ── KYC — aprovar/rejeitar ───────────────────────────────────
  if (action === 'kyc_decidir' && req.method === 'POST') {
    const { kyc_id, decisao, motivo } = req.body || {};
    if (!kyc_id || !['aprovado', 'rejeitado'].includes(decisao))
      return res.status(400).json({ error: 'Dados inválidos.' });

    const kr = await sb(`kyc?id=eq.${kyc_id}&limit=1`);
    const k = (await kr.json())[0];
    if (!k) return res.status(404).json({ error: 'KYC não encontrado.' });

    await sb(`kyc?id=eq.${kyc_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ estado: decisao, verificado_em: new Date().toISOString(), motivo_rejeicao: motivo || null })
    });

    // Promover nível se aprovado
    if (decisao === 'aprovado') {
      await sb(`utilizadores?id=eq.${k.user_id}`, { method: 'PATCH', body: JSON.stringify({ nivel: 'prata', kyc_verificado: true }) }).catch(() => {});
    }

    await sb('notificacoes', {
      method: 'POST',
      body: JSON.stringify({
        user_id: k.user_id,
        titulo: decisao === 'aprovado' ? '✅ KYC Aprovado' : '❌ KYC Rejeitado',
        mensagem: decisao === 'aprovado'
          ? 'A tua identidade foi verificada. A tua conta foi promovida para Prata!'
          : `A tua verificação foi rejeitada. ${motivo ? 'Motivo: ' + motivo : 'Submete novamente.'}`,
        tipo: decisao === 'aprovado' ? 'sucesso' : 'erro'
      })
    }).catch(() => {});

    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: `KYC ${decisao}`, detalhe: `kyc_id: ${kyc_id}${motivo ? ' · ' + motivo : ''}` })
    }).catch(() => {});

    return res.json({ ok: true });
  }

  // ── RISCO — eventos pendentes ────────────────────────────────
  if (action === 'risco_eventos') {
    const r = await sb('risco_eventos?estado=eq.pendente&order=criado_em.desc&limit=50');
    const eventos = await r.json().catch(() => []);
    const enriched = await Promise.all(eventos.map(async e => {
      const ur = await sb(`utilizadores?id=eq.${e.user_id}&select=nome,email&limit=1`).then(r => r.json()).catch(() => []);
      return { ...e, user_nome: ur[0]?.nome || '—', user_email: ur[0]?.email || '—' };
    }));
    return res.json(enriched);
  }

  // ── RISCO — resolver evento ──────────────────────────────────
  if (action === 'risco_resolver' && req.method === 'POST') {
    const { evento_id, accao, notas } = req.body || {};
    if (!evento_id || !accao) return res.status(400).json({ error: 'Dados em falta.' });

    const er = await sb(`risco_eventos?id=eq.${evento_id}&limit=1`);
    const evento = (await er.json())[0];
    if (!evento) return res.status(404).json({ error: 'Evento não encontrado.' });

    await sb(`risco_eventos?id=eq.${evento_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ estado: 'resolvido', accao_tomada: accao, notas: notas || null, resolvido_em: new Date().toISOString() })
    });

    // Se acção for suspender, suspender conta
    if (accao === 'suspender') {
      await sb(`utilizadores?id=eq.${evento.user_id}`, { method: 'PATCH', body: JSON.stringify({ suspenso: true }) });
      await sb(`sessoes?user_id=eq.${evento.user_id}`, { method: 'PATCH', body: JSON.stringify({ activa: false }) }).catch(() => {});
    }

    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Risco Resolvido', detalhe: `id: ${evento_id} · accao: ${accao}${notas ? ' · ' + notas : ''}` })
    }).catch(() => {});

    return res.json({ ok: true });
  }

  // ── GESTÃO DE MERCADOS ───────────────────────────────────────
  if (action === 'criar_evento' && req.method === 'POST') {
    const { liga_id, equipa_casa, equipa_fora, data_inicio, temporada } = req.body || {};
    if (!equipa_casa || !equipa_fora || !data_inicio)
      return res.status(400).json({ error: 'Dados em falta.' });

    const er = await sb('eventos', {
      method: 'POST',
      body: JSON.stringify({
        liga_id: liga_id || null, equipa_casa, equipa_fora,
        data_inicio, temporada: temporada || new Date().getFullYear().toString(),
        estado: 'upcoming', golos_casa: 0, golos_fora: 0
      })
    });
    if (!er.ok) return res.status(500).json({ error: 'Erro ao criar evento.' });
    const evento = (await er.json())[0];

    // Criar mercados padrão automaticamente
    const mercadosPadrao = [
      { nome: 'Resultado Final (1X2)', tipo: '1x2', ordem: 1 },
      { nome: 'Total de Golos', tipo: 'totals', ordem: 2 },
      { nome: 'Ambas as Equipas Marcam', tipo: 'btts', ordem: 3 }
    ];

    for (const m of mercadosPadrao) {
      const mr = await sb('mercados', {
        method: 'POST',
        body: JSON.stringify({ evento_id: evento.id, ...m, activo: true })
      }).catch(() => null);

      if (!mr?.ok) continue;
      const mercado = (await mr.json())[0];

      // Selecções padrão
      const selsPadrao = {
        '1x2': [
          { nome: equipa_casa, abrev: '1', odd: 2.00 },
          { nome: 'Empate', abrev: 'X', odd: 3.20 },
          { nome: equipa_fora, abrev: '2', odd: 3.50 }
        ],
        'totals': [
          { nome: 'Mais de 2.5 Golos', abrev: 'Over 2.5', odd: 1.80 },
          { nome: 'Menos de 2.5 Golos', abrev: 'Under 2.5', odd: 2.00 }
        ],
        'btts': [
          { nome: 'Sim', abrev: 'Sim', odd: 1.75 },
          { nome: 'Não', abrev: 'Não', odd: 2.05 }
        ]
      };

      const sels = selsPadrao[m.tipo] || [];
      for (let i = 0; i < sels.length; i++) {
        await sb('seleccoes', {
          method: 'POST',
          body: JSON.stringify({
            mercado_id: mercado.id, evento_id: evento.id,
            nome: sels[i].nome, abrev: sels[i].abrev,
            odd: sels[i].odd, activa: true, ordem: i + 1
          })
        }).catch(() => {});
      }
    }

    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Evento Criado', detalhe: `${equipa_casa} vs ${equipa_fora} · ${data_inicio}` })
    }).catch(() => {});

    return res.json({ ok: true, evento_id: evento.id });
  }

  // ── ACTUALIZAR ODD ───────────────────────────────────────────
  if (action === 'actualizar_odd' && req.method === 'PATCH') {
    const { seleccao_id, nova_odd, motivo } = req.body || {};
    if (!seleccao_id || !nova_odd) return res.status(400).json({ error: 'Dados em falta.' });

    const oddNum = parseFloat(nova_odd);
    if (isNaN(oddNum) || oddNum < 1.01) return res.status(400).json({ error: 'Odd inválida.' });

    // Buscar odd antiga para histórico
    const sr = await sb(`seleccoes?id=eq.${seleccao_id}&select=odd,mercado_id,evento_id&limit=1`);
    const sel = (await sr.json())[0];
    if (!sel) return res.status(404).json({ error: 'Selecção não encontrada.' });

    // Guardar histórico
    await sb('odds_historico', {
      method: 'POST',
      body: JSON.stringify({
        seleccao_id, mercado_id: sel.mercado_id, evento_id: sel.evento_id,
        odd_anterior: sel.odd, odd_nova: oddNum,
        motivo: motivo || null, alterado_por: 'admin'
      })
    }).catch(() => {});

    await sb(`seleccoes?id=eq.${seleccao_id}`, { method: 'PATCH', body: JSON.stringify({ odd: oddNum }) });

    return res.json({ ok: true, odd_anterior: sel.odd, odd_nova: oddNum });
  }

  // ── ACTUALIZAR ESTADO EVENTO ─────────────────────────────────
  if (action === 'actualizar_evento' && req.method === 'PATCH') {
    const { evento_id, estado, golos_casa, golos_fora, minuto } = req.body || {};
    if (!evento_id) return res.status(400).json({ error: 'evento_id em falta.' });

    const update = {};
    if (estado) update.estado = estado;
    if (golos_casa !== undefined) update.golos_casa = parseInt(golos_casa);
    if (golos_fora !== undefined) update.golos_fora = parseInt(golos_fora);
    if (minuto !== undefined) update.minuto_atual = parseInt(minuto);

    await sb(`eventos?id=eq.${evento_id}`, { method: 'PATCH', body: JSON.stringify(update) });
    return res.json({ ok: true });
  }

  // ── AFILIADOS ────────────────────────────────────────────────
  if (action === 'afiliados') {
    const r = await sb('afiliados?select=*&order=criado_em.desc&limit=50');
    const afs = await r.json().catch(() => []);
    const enriched = await Promise.all(afs.map(async a => {
      const [ur, refs] = await Promise.all([
        sb(`utilizadores?id=eq.${a.user_id}&select=nome,email&limit=1`).then(r => r.json()).catch(() => []),
        sb(`referidos?afiliado_id=eq.${a.user_id}&select=id,estado`).then(r => r.json()).catch(() => [])
      ]);
      return { ...a, user_nome: ur[0]?.nome || '—', total_referidos: refs.length, referidos_activos: refs.filter(r => r.estado === 'activo').length };
    }));
    return res.json(enriched);
  }

  // ── BÓNUS — gerir ────────────────────────────────────────────
  if (action === 'bonus_criar' && req.method === 'POST') {
    const { user_id, tipo, valor, rollover, notas } = req.body || {};
    if (!user_id || !valor) return res.status(400).json({ error: 'Dados em falta.' });

    const valorNum = parseFloat(valor);
    await sb('bonus', {
      method: 'POST',
      body: JSON.stringify({
        user_id, tipo: tipo || 'manual', valor: valorNum,
        rollover: rollover || 1, rollover_completado: 0,
        estado: 'activo', notas: notas || null,
        expires_at: new Date(Date.now() + 30 * 86400000).toISOString()
      })
    });
    await ledger(user_id, 'bonus', valorNum, null, `Bónus manual: ${notas || tipo || 'admin'}`, { admin: ADMIN_EMAIL });
    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Bónus Criado', detalhe: `user_id: ${user_id} · ${valorNum} Kz · ${tipo}` })
    }).catch(() => {});

    return res.json({ ok: true });
  }

  // ── CONFIGURAÇÕES DO SISTEMA ─────────────────────────────────
  if (action === 'config' && req.method === 'GET') {
    const r = await sb('config_sistema?select=*');
    return res.json(await r.json().catch(() => []));
  }

  if (action === 'config_set' && req.method === 'POST') {
    const { chave, valor, descricao } = req.body || {};
    if (!chave || valor === undefined) return res.status(400).json({ error: 'Dados em falta.' });

    const existeR = await sb(`config_sistema?chave=eq.${chave}&limit=1`);
    const existe = (await existeR.json().catch(() => []))[0];

    if (existe) {
      await sb(`config_sistema?chave=eq.${chave}`, { method: 'PATCH', body: JSON.stringify({ valor: String(valor) }) });
    } else {
      await sb('config_sistema', { method: 'POST', body: JSON.stringify({ chave, valor: String(valor), descricao: descricao || '' }) });
    }

    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Config Alterada', detalhe: `${chave} = ${valor}` })
    }).catch(() => {});

    return res.json({ ok: true });
  }

  // ── LEDGER — auditoria financeira ────────────────────────────
  if (action === 'ledger') {
    const { user_id, tipo, limit = 50 } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 50, 500);
    let q = `ledger?order=criado_em.desc&limit=${safeLimit}`;
    if (user_id) q += `&user_id=eq.${user_id}`;
    if (tipo) q += `&tipo=eq.${tipo}`;
    const r = await sb(q);
    return res.json(await r.json().catch(() => []));
  }

  // ── LOGS ─────────────────────────────────────────────────────
  if (action === 'logs') {
    const r = await sb('admin_logs?order=criado_em.desc&limit=100');
    return res.json(await r.json().catch(() => []));
  }

  // ── NOTIFICAÇÃO MANUAL ───────────────────────────────────────
  if (action === 'notificar' && req.method === 'POST') {
    const { user_id, titulo, mensagem, tipo } = req.body || {};
    if (!user_id || !titulo || !mensagem) return res.status(400).json({ error: 'Dados em falta.' });
    await sb('notificacoes', { method: 'POST', body: JSON.stringify({ user_id, titulo, mensagem, tipo: tipo || 'info' }) });
    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Notificação Enviada', detalhe: `user_id: ${user_id} · ${titulo}` })
    }).catch(() => {});
    return res.json({ ok: true });
  }

  // ── NOTIFICAÇÃO BROADCAST ────────────────────────────────────
  if (action === 'broadcast' && req.method === 'POST') {
    const { titulo, mensagem, tipo, nivel_min } = req.body || {};
    if (!titulo || !mensagem) return res.status(400).json({ error: 'Dados em falta.' });

    let q = 'utilizadores?select=id&suspenso=eq.false';
    if (nivel_min) q += `&nivel=eq.${nivel_min}`;
    const usersR = await sb(q);
    const users = await usersR.json().catch(() => []);

    let enviadas = 0;
    for (const u of users.slice(0, 1000)) {
      await sb('notificacoes', {
        method: 'POST',
        body: JSON.stringify({ user_id: u.id, titulo, mensagem, tipo: tipo || 'info' })
      }).catch(() => {});
      enviadas++;
    }

    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Broadcast', detalhe: `${titulo} · ${enviadas} utilizadores` })
    }).catch(() => {});

    return res.json({ ok: true, enviadas });
  }

  // ── RELATÓRIO FINANCEIRO ─────────────────────────────────────
  if (action === 'relatorio') {
    const { desde, ate } = req.query;
    let q = 'transacoes?select=tipo,metodo,valor,estado,criado_em&order=criado_em.desc';
    if (desde) q += `&criado_em=gte.${desde}`;
    if (ate) q += `&criado_em=lte.${ate}`;
    const r = await sb(q);
    const txs = await r.json().catch(() => []);
    if (!Array.isArray(txs)) return res.json({ error: 'Erro ao carregar dados.' });
    const relatorio = {};
    for (const tx of txs) {
      const met = tx.metodo || 'outros';
      if (!relatorio[met]) relatorio[met] = { depositos: 0, levantamentos: 0, count: 0 };
      if (tx.tipo === 'deposito' && tx.estado === 'aprovado') relatorio[met].depositos += parseFloat(tx.valor || 0);
      if (tx.tipo === 'levantamento') relatorio[met].levantamentos += parseFloat(tx.valor || 0);
      relatorio[met].count++;
    }
    return res.json(relatorio);
  }

  res.status(404).json({ error: 'Acção não encontrada.' });
};
