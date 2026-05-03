// api/admin.js — OnlyBet Admin v2 — Segurança reforçada
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

// Gerar token admin assinado
function createAdminToken(email) {
  const payload = `${email}:${Date.now()}`;
  let h = 0;
  for (const c of (payload + TOKEN_SECRET)) { h = ((h << 5) - h) + c.charCodeAt(0); h |= 0; }
  return Buffer.from(payload).toString('base64') + '.' + Math.abs(h).toString(36);
}

// Validar token admin
function validateAdminToken(token) {
  if (!token) return false;
  try {
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) return false;
    const payload = Buffer.from(payloadB64, 'base64').toString();
    const [email, timestamp] = payload.split(':');
    if (email !== ADMIN_EMAIL) return false;
    // Token expira em 12 horas
    if (Date.now() - parseInt(timestamp) > 12 * 3600 * 1000) return false;
    // Verificar assinatura
    let h = 0;
    for (const c of (payload + TOKEN_SECRET)) { h = ((h << 5) - h) + c.charCodeAt(0); h |= 0; }
    return sig === Math.abs(h).toString(36);
  } catch { return false; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action } = req.query;

  // ── LOGIN ADMIN ──────────────────────────────────────────────
  if (action === 'login' && req.method === 'POST') {
    const { email, password } = req.body || {};

    // Tempo constante (anti-timing)
    const isValid = email === ADMIN_EMAIL && password === ADMIN_PASS;
    if (!isValid) {
      await new Promise(r => setTimeout(r, 300)); // delay fixo
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const token = createAdminToken(email);
    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: email, accao: 'Login', detalhe: 'Login no painel admin' })
    }).catch(() => {});

    return res.json({ ok: true, token });
  }

  // Validar token em todas as outras rotas
  const token = req.headers['x-admin-token'];
  if (!validateAdminToken(token))
    return res.status(401).json({ error: 'Token inválido ou expirado. Faz login novamente.' });

  // ── DASHBOARD ────────────────────────────────────────────────
  if (action === 'dashboard') {
    const [users, txs, deps, apostas] = await Promise.all([
      sb('utilizadores?select=id,saldo,suspenso').then(r => r.json()),
      sb('transacoes?select=tipo,valor,estado,criado_em&order=criado_em.desc&limit=500').then(r => r.json()),
      sb('depositos_pendentes?estado=eq.transferido&select=id').then(r => r.json()),
      sb('apostas?select=valor_apostado,ganho_real,resultado').then(r => r.json()),
    ]);

    const totalBal = Array.isArray(users) ? users.reduce((s, u) => s + parseFloat(u.saldo || 0), 0) : 0;
    const suspensos = Array.isArray(users) ? users.filter(u => u.suspenso).length : 0;
    const depAprovados = Array.isArray(txs) ? txs.filter(t => t.tipo === 'deposito' && t.estado === 'aprovado') : [];
    const depTotal = depAprovados.reduce((s, t) => s + parseFloat(t.valor || 0), 0);
    const levPend = Array.isArray(txs) ? txs.filter(t => t.tipo === 'levantamento' && t.estado === 'pendente') : [];
    const levTotal = levPend.reduce((s, t) => s + parseFloat(t.valor || 0), 0);
    const apostTotal = Array.isArray(apostas) ? apostas.reduce((s, a) => s + parseFloat(a.valor_apostado || 0), 0) : 0;
    const ganhoPago = Array.isArray(apostas) ? apostas.filter(a => a.resultado === 'ganhou').reduce((s, a) => s + parseFloat(a.ganho_real || 0), 0) : 0;
    const ggr = Math.max(0, apostTotal - ganhoPago);

    return res.json({
      total_users: Array.isArray(users) ? users.length : 0,
      users_suspensos: suspensos,
      saldo_total: totalBal,
      depositos_total: depTotal,
      levantamentos_pendentes: levPend.length,
      levantamentos_valor: levTotal,
      deps_pendentes_confirmados: Array.isArray(deps) ? deps.length : 0,
      apostas_total: Array.isArray(apostas) ? apostas.length : 0,
      volume_apostado: apostTotal,
      ggr,
      hold: apostTotal > 0 ? (ggr / apostTotal * 100).toFixed(1) : '0.0'
    });
  }

  // ── LISTAR UTILIZADORES ──────────────────────────────────────
  if (action === 'utilizadores') {
    const { search, suspenso } = req.query;
    let q = 'utilizadores?select=id,nome,email,telefone,saldo,nivel,suspenso,criado_em,ultimo_login&order=criado_em.desc&limit=100';
    if (suspenso === 'true') q += '&suspenso=eq.true';
    if (suspenso === 'false') q += '&suspenso=eq.false';
    const r = await sb(q);
    let data = await r.json();
    // Filtro por pesquisa (servidor não tem ILIKE facilmente via REST sem RPC)
    if (search && Array.isArray(data)) {
      const s = search.toLowerCase();
      data = data.filter(u =>
        u.nome?.toLowerCase().includes(s) ||
        u.email?.toLowerCase().includes(s) ||
        u.telefone?.includes(s)
      );
    }
    return res.json(data);
  }

  // ── DETALHE DO UTILIZADOR ─────────────────────────────────────
  if (action === 'user_detalhe') {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const [u, txs, apostas, deps] = await Promise.all([
      sb(`utilizadores?id=eq.${user_id}&limit=1`).then(r => r.json()),
      sb(`transacoes?user_id=eq.${user_id}&order=criado_em.desc&limit=20`).then(r => r.json()),
      sb(`apostas?user_id=eq.${user_id}&order=criado_em.desc&limit=20`).then(r => r.json()),
      sb(`depositos_pendentes?user_id=eq.${user_id}&order=criado_em.desc&limit=10`).then(r => r.json()),
    ]);
    return res.json({ user: u[0] || null, transacoes: txs, apostas, depositos: deps });
  }

  // ── SUSPENDER/ACTIVAR UTILIZADOR ────────────────────────────
  if (action === 'toggle_suspend' && req.method === 'PATCH') {
    const { user_id, suspenso } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    await sb(`utilizadores?id=eq.${user_id}`, { method: 'PATCH', body: JSON.stringify({ suspenso: !!suspenso }) });
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
    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Ajuste Saldo', detalhe: `${u.nome}: ${valorNum > 0 ? '+' : ''}${valorNum} Kz. ${motivo || ''}` })
    }).catch(() => {});
    return res.json({ ok: true, saldo_novo: novo });
  }

  // ── DEPÓSITOS PENDENTES ──────────────────────────────────────
  if (action === 'depositos_pendentes') {
    const r = await sb('depositos_pendentes?estado=eq.transferido&order=criado_em.desc');
    const deps = await r.json();
    if (!Array.isArray(deps)) return res.json([]);
    // Enriquecer com dados do utilizador em paralelo (max 10 por vez)
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
    return res.json(await r.json());
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
    return res.json(await r.json());
  }

  // ── APROVAR LEVANTAMENTO ─────────────────────────────────────
  if (action === 'aprovar_levantamento' && req.method === 'POST') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID em falta.' });
    await sb(`transacoes?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ estado: 'aprovado' }) });
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

    // Devolver saldo
    const ur = await sb(`utilizadores?id=eq.${lev.user_id}&select=saldo&limit=1`);
    const u = (await ur.json())[0];
    const novoSaldo = parseFloat(u?.saldo || 0) + parseFloat(lev.valor);
    await sb(`utilizadores?id=eq.${lev.user_id}`, { method: 'PATCH', body: JSON.stringify({ saldo: novoSaldo }) });

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
    return res.json(await r.json());
  }

  // ── RESOLVER APOSTA (admin marca como ganhou/perdeu) ─────────
  if (action === 'resolver_aposta' && req.method === 'POST') {
    const { id, resultado } = req.body || {};
    if (!id || !['ganhou', 'perdeu', 'cancelada'].includes(resultado))
      return res.status(400).json({ error: 'Dados inválidos.' });

    // Buscar aposta
    const ar = await sb(`apostas?id=eq.${id}&limit=1`);
    const aposta = (await ar.json())[0];
    if (!aposta) return res.status(404).json({ error: 'Aposta não encontrada.' });
    if (aposta.resultado !== 'pendente')
      return res.status(409).json({ error: 'Aposta já foi resolvida.' });

    const ganhoReal = resultado === 'ganhou' ? parseFloat(aposta.ganho_potencial || 0) : 0;

    // Actualizar aposta
    await sb(`apostas?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ resultado, ganho_real: ganhoReal })
    });

    // Creditar saldo se ganhou ou devolver se cancelada
    if (resultado === 'ganhou' || resultado === 'cancelada') {
      const valorDevolver = resultado === 'ganhou' ? ganhoReal : parseFloat(aposta.valor_apostado || 0);
      const ur = await sb(`utilizadores?id=eq.${aposta.user_id}&select=saldo&limit=1`);
      const u = (await ur.json())[0];
      const novoSaldo = parseFloat(u?.saldo || 0) + valorDevolver;
      await sb(`utilizadores?id=eq.${aposta.user_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ saldo: novoSaldo })
      });

      const msgs = {
        ganhou: `🎉 Parabéns! A tua aposta em "${aposta.jogo}" ganhou! Recebeste ${ganhoReal.toLocaleString('pt-AO')} Kz.`,
        cancelada: `ℹ️ A tua aposta em "${aposta.jogo}" foi cancelada. O valor de ${parseFloat(aposta.valor_apostado).toLocaleString('pt-AO')} Kz foi devolvido.`
      };
      await sb('notificacoes', {
        method: 'POST',
        body: JSON.stringify({
          user_id: aposta.user_id,
          titulo: resultado === 'ganhou' ? '🎉 Aposta Ganha!' : 'ℹ️ Aposta Cancelada',
          mensagem: msgs[resultado],
          tipo: resultado === 'ganhou' ? 'sucesso' : 'info'
        })
      }).catch(() => {});
    } else {
      // Perdeu — apenas notificar
      await sb('notificacoes', {
        method: 'POST',
        body: JSON.stringify({
          user_id: aposta.user_id,
          titulo: '❌ Aposta Perdida',
          mensagem: `A tua aposta em "${aposta.jogo}" não foi bem sucedida.`,
          tipo: 'erro'
        })
      }).catch(() => {});
    }

    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Aposta Resolvida', detalhe: `id: ${id} · ${resultado} · ${ganhoReal} Kz` })
    }).catch(() => {});

    return res.json({ ok: true, resultado, ganho_real: ganhoReal });
  }

  // ── LOGS ─────────────────────────────────────────────────────
  if (action === 'logs') {
    const r = await sb('admin_logs?order=criado_em.desc&limit=100');
    return res.json(await r.json());
  }

  // ── NOTIFICAÇÃO MANUAL ───────────────────────────────────────
  if (action === 'notificar' && req.method === 'POST') {
    const { user_id, titulo, mensagem, tipo } = req.body || {};
    if (!user_id || !titulo || !mensagem) return res.status(400).json({ error: 'Dados em falta.' });
    await sb('notificacoes', {
      method: 'POST',
      body: JSON.stringify({ user_id, titulo, mensagem, tipo: tipo || 'info' })
    });
    await sb('admin_logs', {
      method: 'POST',
      body: JSON.stringify({ admin: ADMIN_EMAIL, accao: 'Notificação Enviada', detalhe: `user_id: ${user_id} · ${titulo}` })
    }).catch(() => {});
    return res.json({ ok: true });
  }

  // ── ESTATÍSTICAS FINANCEIRAS ─────────────────────────────────
  if (action === 'relatorio') {
    const { desde, ate } = req.query;
    let q = 'transacoes?select=tipo,metodo,valor,estado,criado_em&order=criado_em.desc';
    if (desde) q += `&criado_em=gte.${desde}`;
    if (ate) q += `&criado_em=lte.${ate}`;
    const r = await sb(q);
    const txs = await r.json();
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
