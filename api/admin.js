// api/admin.js — Painel Admin via Supabase
const SUPABASE_URL = 'https://kgxhsuetfclgffpyshsg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET || 'sb_secret_il45ucBYJ3sWRzc4I2NdSw_BjEB2Mb_';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123'; // Muda nas env vars do Vercel!

const sb = (path, opts={}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
  headers: {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': opts.prefer || 'return=representation',
    ...opts.headers
  },
  ...opts
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action } = req.query;

  // ── LOGIN ADMIN ──────────────────────────────────────────────
  if (action === 'login' && req.method === 'POST') {
    const { email, password } = req.body;
    if (email === 'admin@onlybet.ao' && password === ADMIN_PASS) {
      const token = Buffer.from(`${email}:${Date.now()}`).toString('base64');
      await sb('admin_logs', { method:'POST', body: JSON.stringify({ admin: email, accao:'Login', detalhe:'Login no painel admin' }) });
      return res.json({ ok: true, token });
    }
    return res.status(401).json({ error: 'Credenciais inválidas.' });
  }

  // Verificar token admin em todas as outras rotas
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Token admin em falta.' });

  // ── DASHBOARD ────────────────────────────────────────────────
  if (action === 'dashboard') {
    const [users, txs, deps, apostas] = await Promise.all([
      sb('utilizadores?select=id,saldo').then(r=>r.json()),
      sb('transacoes?select=tipo,valor,estado,criado_em').then(r=>r.json()),
      sb('depositos_pendentes?estado=eq.transferido&select=*').then(r=>r.json()),
      sb('apostas?select=valor_apostado,ganho_real,resultado').then(r=>r.json()),
    ]);
    const totalBal = users.reduce((s,u)=>s+parseFloat(u.saldo||0),0);
    const depAprovados = txs.filter(t=>t.tipo==='deposito'&&t.estado==='aprovado');
    const depTotal = depAprovados.reduce((s,t)=>s+parseFloat(t.valor||0),0);
    const levPend = txs.filter(t=>t.tipo==='levantamento'&&t.estado==='pendente');
    const levTotal = levPend.reduce((s,t)=>s+parseFloat(t.valor||0),0);
    const apostTotal = apostas.reduce((s,a)=>s+parseFloat(a.valor_apostado||0),0);
    const ganhoPago = apostas.filter(a=>a.resultado==='ganhou').reduce((s,a)=>s+parseFloat(a.ganho_real||0),0);
    const ggr = Math.max(0, apostTotal - ganhoPago);
    return res.json({
      total_users: users.length,
      saldo_total: totalBal,
      depositos_total: depTotal,
      levantamentos_pendentes: levPend.length,
      levantamentos_valor: levTotal,
      deps_pendentes_confirmados: deps.length,
      apostas_total: apostas.length,
      volume_apostado: apostTotal,
      ggr,
      hold: apostTotal > 0 ? (ggr/apostTotal*100).toFixed(1) : 0
    });
  }

  // ── LISTAR UTILIZADORES ──────────────────────────────────────
  if (action === 'utilizadores') {
    const r = await sb('utilizadores?select=id,nome,email,telefone,saldo,nivel,suspenso,criado_em&order=criado_em.desc&limit=100');
    return res.json(await r.json());
  }

  // ── SUSPENDER/ACTIVAR UTILIZADOR ────────────────────────────
  if (action === 'toggle_suspend' && req.method === 'PATCH') {
    const { user_id, suspenso } = req.body;
    await sb(`utilizadores?id=eq.${user_id}`, { method:'PATCH', body: JSON.stringify({ suspenso }) });
    await sb('admin_logs', { method:'POST', body: JSON.stringify({ admin:'admin', accao:suspenso?'Conta Suspensa':'Conta Activada', detalhe:`user_id: ${user_id}` }) });
    return res.json({ ok: true });
  }

  // ── AJUSTAR SALDO ────────────────────────────────────────────
  if (action === 'ajustar_saldo' && req.method === 'PATCH') {
    const { user_id, valor, motivo } = req.body;
    const ur = await sb(`utilizadores?id=eq.${user_id}&select=saldo,nome&limit=1`);
    const u = (await ur.json())[0];
    if (!u) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    const novo = Math.max(0, parseFloat(u.saldo||0) + parseFloat(valor));
    await sb(`utilizadores?id=eq.${user_id}`, { method:'PATCH', body: JSON.stringify({ saldo: novo }) });
    await sb('transacoes', { method:'POST', body: JSON.stringify({ user_id, tipo:'ajuste', valor: Math.abs(valor), estado:'aprovado', notas: motivo||'Ajuste manual admin' }) });
    await sb('admin_logs', { method:'POST', body: JSON.stringify({ admin:'admin', accao:'Ajuste Saldo', detalhe:`${u.nome}: ${valor>0?'+':''}${valor} Kz. ${motivo||''}` }) });
    return res.json({ ok: true, saldo_novo: novo });
  }

  // ── DEPÓSITOS PENDENTES ──────────────────────────────────────
  if (action === 'depositos_pendentes') {
    const r = await sb('depositos_pendentes?estado=eq.transferido&order=criado_em.desc');
    const deps = await r.json();
    // Enriquecer com dados do utilizador
    const enriched = await Promise.all(deps.map(async d => {
      const ur = await sb(`utilizadores?id=eq.${d.user_id}&select=nome,telefone&limit=1`);
      const u = (await ur.json())[0];
      return { ...d, user_nome: u?.nome||'—', user_telefone: u?.telefone||'—' };
    }));
    return res.json(enriched);
  }

  // ── APROVAR DEPÓSITO ─────────────────────────────────────────
  if (action === 'aprovar_deposito' && req.method === 'POST') {
    const { ref } = req.body;
    const dr = await sb(`depositos_pendentes?referencia=eq.${ref}&limit=1`);
    const dep = (await dr.json())[0];
    if (!dep) return res.status(404).json({ error: 'Depósito não encontrado.' });

    // Actualizar estado
    await sb(`depositos_pendentes?referencia=eq.${ref}`, { method:'PATCH', body: JSON.stringify({ estado:'aprovado' }) });

    // Creditar saldo
    const ur = await sb(`utilizadores?id=eq.${dep.user_id}&select=saldo&limit=1`);
    const u = (await ur.json())[0];
    const novoSaldo = parseFloat(u?.saldo||0) + parseFloat(dep.valor);
    await sb(`utilizadores?id=eq.${dep.user_id}`, { method:'PATCH', body: JSON.stringify({ saldo: novoSaldo }) });

    // Registar transação
    await sb('transacoes', { method:'POST', body: JSON.stringify({ user_id:dep.user_id, tipo:'deposito', metodo:dep.metodo, valor:dep.valor, estado:'aprovado', referencia:ref }) });

    // Notificação ao utilizador
    await sb('notificacoes', { method:'POST', body: JSON.stringify({ user_id:dep.user_id, titulo:'Depósito Aprovado! ✅', mensagem:`O teu depósito de ${parseFloat(dep.valor).toLocaleString('pt-AO')} Kz foi creditado.`, tipo:'sucesso' }) });

    await sb('admin_logs', { method:'POST', body: JSON.stringify({ admin:'admin', accao:'Depósito Aprovado', detalhe:`Ref: ${ref} · ${dep.valor} Kz` }) });
    return res.json({ ok: true, saldo_novo: novoSaldo });
  }

  // ── REJEITAR DEPÓSITO ────────────────────────────────────────
  if (action === 'rejeitar_deposito' && req.method === 'POST') {
    const { ref } = req.body;
    await sb(`depositos_pendentes?referencia=eq.${ref}`, { method:'PATCH', body: JSON.stringify({ estado:'rejeitado' }) });
    await sb('admin_logs', { method:'POST', body: JSON.stringify({ admin:'admin', accao:'Depósito Rejeitado', detalhe:`Ref: ${ref}` }) });
    return res.json({ ok: true });
  }

  // ── TODOS OS DEPÓSITOS ───────────────────────────────────────
  if (action === 'depositos') {
    const { estado } = req.query;
    let q = 'depositos_pendentes?order=criado_em.desc&limit=100';
    if (estado && estado !== 'all') q += `&estado=eq.${estado}`;
    const r = await sb(q); return res.json(await r.json());
  }

  // ── LEVANTAMENTOS ────────────────────────────────────────────
  if (action === 'levantamentos') {
    const r = await sb('transacoes?tipo=eq.levantamento&order=criado_em.desc&limit=100');
    return res.json(await r.json());
  }

  // ── APROVAR LEVANTAMENTO ─────────────────────────────────────
  if (action === 'aprovar_levantamento' && req.method === 'POST') {
    const { id } = req.body;
    await sb(`transacoes?id=eq.${id}`, { method:'PATCH', body: JSON.stringify({ estado:'aprovado' }) });
    await sb('admin_logs', { method:'POST', body: JSON.stringify({ admin:'admin', accao:'Levantamento Aprovado', detalhe:`id: ${id}` }) });
    return res.json({ ok: true });
  }

  // ── APOSTAS ──────────────────────────────────────────────────
  if (action === 'apostas') {
    const r = await sb('apostas?order=criado_em.desc&limit=100');
    return res.json(await r.json());
  }

  // ── LOGS ─────────────────────────────────────────────────────
  if (action === 'logs') {
    const r = await sb('admin_logs?order=criado_em.desc&limit=100');
    return res.json(await r.json());
  }

  // ── NOTIFICAÇÕES ─────────────────────────────────────────────
  if (action === 'notificacoes') {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const r = await sb(`notificacoes?user_id=eq.${user_id}&order=criado_em.desc&limit=20`);
    return res.json(await r.json());
  }

  res.status(404).json({ error: 'Acção não encontrada.' });
};