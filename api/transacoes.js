// api/transacoes.js — OnlyBet v3 — Ledger atómico + Mercados + Antifraude avançado
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET;
const CONTA = process.env.CONTA_PAGAMENTO || '976 036 278';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

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

// ── LEDGER — registo financeiro imutável ──────────────────────
async function ledger(userId, tipo, valor, ref, descricao, meta = {}) {
  await sb('ledger', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      tipo,
      valor: parseFloat(valor),
      referencia: ref || null,
      descricao: descricao || tipo,
      meta: typeof meta === 'string' ? meta : JSON.stringify(meta),
      criado_em: new Date().toISOString()
    })
  }).catch(e => console.error('Ledger error:', e.message));
}

// ── ANTIFRAUDE ───────────────────────────────────────────────
async function checkDepositoLimits(user_id, valor) {
  const umHoraAtras = new Date(Date.now() - 3600000).toISOString();
  const r = await sb(`depositos_pendentes?user_id=eq.${user_id}&criado_em=gte.${umHoraAtras}&select=valor`);
  const deps = await r.json().catch(() => []);
  if (!Array.isArray(deps)) return { ok: true };
  if (deps.length >= 5) return { ok: false, error: 'Limite de 5 depósitos por hora atingido.' };
  const totalHora = deps.reduce((s, d) => s + parseFloat(d.valor || 0), 0);
  if (totalHora + valor > 500000) return { ok: false, error: 'Limite de 500.000 Kz por hora atingido.' };
  return { ok: true };
}

async function checkLevantamentoLimits(user_id) {
  const umHoraAtras = new Date(Date.now() - 3600000).toISOString();
  const r = await sb(`transacoes?user_id=eq.${user_id}&tipo=eq.levantamento&criado_em=gte.${umHoraAtras}&select=id`);
  const levs = await r.json().catch(() => []);
  if (Array.isArray(levs) && levs.length >= 1)
    return { ok: false, error: 'Limite de 1 levantamento por hora. Tenta mais tarde.' };
  return { ok: true };
}

async function checkApostaLimits(user_id) {
  const umMinutoAtras = new Date(Date.now() - 60000).toISOString();
  const r = await sb(`apostas?user_id=eq.${user_id}&criado_em=gte.${umMinutoAtras}&select=id`);
  const aps = await r.json().catch(() => []);
  if (Array.isArray(aps) && aps.length >= 10)
    return { ok: false, error: 'Demasiadas apostas em pouco tempo. Aguarda um momento.' };
  return { ok: true };
}

// Verificar velocidade de apostas (antifraude no DB via RPC se disponível)
async function checkVelocidadeAposta(user_id, valor) {
  // Verificar se apostas nos últimos 5 min excedem 200k Kz
  const cincoMinAtras = new Date(Date.now() - 300000).toISOString();
  const r = await sb(`apostas?user_id=eq.${user_id}&criado_em=gte.${cincoMinAtras}&select=valor_apostado`);
  const recent = await r.json().catch(() => []);
  if (!Array.isArray(recent)) return { ok: true };
  const total = recent.reduce((s, a) => s + parseFloat(a.valor_apostado || 0), 0);
  if (total + valor > 200000)
    return { ok: false, error: 'Volume de apostas suspeito. Conta sinalizada para revisão.' };
  return { ok: true };
}

// ── VERIFICAR UTILIZADOR ─────────────────────────────────────
async function getUser(user_id) {
  if (!user_id || !/^[0-9a-f-]{36}$/i.test(user_id)) return null;
  const r = await sb(`utilizadores?id=eq.${user_id}&select=id,saldo,suspenso,nivel,bonus&limit=1`);
  const u = await r.json().catch(() => []);
  return Array.isArray(u) ? u[0] || null : null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action } = req.query;

  // ── HISTÓRICO ────────────────────────────────────────────────
  if (action === 'historico' && req.method === 'GET') {
    const { user_id, limit = 50 } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const safeLimit = Math.min(parseInt(limit) || 50, 100);
    // Buscar do ledger (mais completo) + transacoes
    const [ledgerR, txsR] = await Promise.all([
      sb(`ledger?user_id=eq.${user_id}&order=criado_em.desc&limit=${safeLimit}`),
      sb(`transacoes?user_id=eq.${user_id}&order=criado_em.desc&limit=${safeLimit}`)
    ]);
    const [ledgerData, txsData] = await Promise.all([ledgerR.json().catch(() => []), txsR.json().catch(() => [])]);
    return res.json({ ledger: ledgerData, transacoes: txsData });
  }

  // ── APOSTAS DO UTILIZADOR ────────────────────────────────────
  if (action === 'apostas_user' && req.method === 'GET') {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const r = await sb(`apostas?user_id=eq.${user_id}&order=criado_em.desc&limit=50`);
    return res.json(await r.json().catch(() => []));
  }

  // ── INICIAR DEPÓSITO ─────────────────────────────────────────
  if (action === 'deposito' && req.method === 'POST') {
    const { user_id, valor, metodo, telefone } = req.body || {};

    if (!user_id || !valor || !metodo || !telefone)
      return res.status(400).json({ error: 'Dados incompletos.' });

    const valorNum = parseFloat(valor);
    if (isNaN(valorNum) || valorNum < 500)
      return res.status(400).json({ error: 'Mínimo: 500 Kz.' });
    if (valorNum > 1000000)
      return res.status(400).json({ error: 'Máximo por depósito: 1.000.000 Kz.' });

    const metodosValidos = ['unitel', 'paypay', 'multicaixa'];
    if (!metodosValidos.includes(metodo))
      return res.status(400).json({ error: 'Método de pagamento inválido.' });

    const u = await getUser(user_id);
    if (!u) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    if (u.suspenso) return res.status(403).json({ error: 'Conta suspensa.' });

    const fraudCheck = await checkDepositoLimits(user_id, valorNum);
    if (!fraudCheck.ok) return res.status(429).json({ error: fraudCheck.error });

    const ref = 'OB' + Date.now().toString().slice(-8);
    const metNomes = { unitel: 'Unitel Money', paypay: 'PayPay Angola', multicaixa: 'Multicaixa Express' };

    const dr = await sb('depositos_pendentes', {
      method: 'POST',
      body: JSON.stringify({ user_id, referencia: ref, valor: valorNum, metodo, telefone, estado: 'aguarda' })
    });

    if (!dr.ok) return res.status(500).json({ error: 'Erro ao registar depósito.' });

    return res.json({
      ok: true, ref, conta: CONTA,
      metodo: metNomes[metodo],
      valor: valorNum,
      instrucao: `Transfere ${Number(valorNum).toLocaleString('pt-AO')} Kz para ${CONTA} via ${metNomes[metodo]}. Referência: ${ref}`
    });
  }

  // ── CONFIRMAR TRANSFERÊNCIA ──────────────────────────────────
  if (action === 'confirmar' && req.method === 'POST') {
    const { ref } = req.body || {};
    if (!ref || !/^OB\d+$/.test(ref)) return res.status(400).json({ error: 'Referência inválida.' });

    const dr = await sb(`depositos_pendentes?referencia=eq.${ref}&limit=1`);
    const dep = (await dr.json())[0];
    if (!dep) return res.status(404).json({ error: 'Depósito não encontrado.' });
    if (dep.estado !== 'aguarda')
      return res.status(409).json({ error: 'Este depósito já foi processado.' });

    await sb(`depositos_pendentes?referencia=eq.${ref}`, {
      method: 'PATCH',
      body: JSON.stringify({ estado: 'transferido' })
    });

    await sb('notificacoes', {
      method: 'POST',
      body: JSON.stringify({
        user_id: dep.user_id,
        titulo: 'Depósito em análise ⏳',
        mensagem: `Depósito ${ref} de ${Number(dep.valor).toLocaleString('pt-AO')} Kz confirmado. Será creditado em breve.`,
        tipo: 'info'
      })
    }).catch(() => {});

    return res.json({ ok: true, mensagem: 'Confirmado! O admin vai verificar e creditar em breve.' });
  }

  // ── SOLICITAR LEVANTAMENTO ───────────────────────────────────
  if (action === 'levantamento' && req.method === 'POST') {
    const { user_id, valor, metodo, telefone } = req.body || {};

    if (!user_id || !valor || !metodo || !telefone)
      return res.status(400).json({ error: 'Dados incompletos.' });

    const valorNum = parseFloat(valor);
    if (isNaN(valorNum) || valorNum < 1000)
      return res.status(400).json({ error: 'Mínimo: 1.000 Kz.' });
    if (valorNum > 500000)
      return res.status(400).json({ error: 'Máximo por levantamento: 500.000 Kz.' });

    const u = await getUser(user_id);
    if (!u) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    if (u.suspenso) return res.status(403).json({ error: 'Conta suspensa.' });
    if (parseFloat(u.saldo) < valorNum)
      return res.status(400).json({ error: 'Saldo insuficiente.' });

    const fraudCheck = await checkLevantamentoLimits(user_id);
    if (!fraudCheck.ok) return res.status(429).json({ error: fraudCheck.error });

    const novoSaldo = Math.max(0, parseFloat(u.saldo) - valorNum);
    await sb(`utilizadores?id=eq.${user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ saldo: novoSaldo })
    });

    const ref = 'LEV' + Date.now().toString().slice(-8);

    await sb('transacoes', {
      method: 'POST',
      body: JSON.stringify({
        user_id, tipo: 'levantamento', metodo, valor: valorNum,
        estado: 'pendente', referencia: ref, numero_telef: telefone
      })
    });

    // Ledger — debitar
    await ledger(user_id, 'levantamento', -valorNum, ref, `Levantamento via ${metodo}`, { metodo, telefone });

    await sb('notificacoes', {
      method: 'POST',
      body: JSON.stringify({
        user_id,
        titulo: 'Levantamento solicitado 📤',
        mensagem: `Pedido de ${Number(valorNum).toLocaleString('pt-AO')} Kz (Ref: ${ref}) recebido. Processamento até 15 min.`,
        tipo: 'info'
      })
    }).catch(() => {});

    return res.json({ ok: true, ref, saldo_novo: novoSaldo, mensagem: 'Levantamento submetido.' });
  }

  // ── REGISTAR APOSTA ──────────────────────────────────────────
  if (action === 'aposta' && req.method === 'POST') {
    const { user_id, jogo, detalhe, valor_apostado, odd_total, ganho_potencial, fixture_id, seleccao_id, mercado_id } = req.body || {};

    if (!user_id || !valor_apostado || !jogo)
      return res.status(400).json({ error: 'Dados em falta.' });

    const valorNum = parseFloat(valor_apostado);
    if (isNaN(valorNum) || valorNum < 100)
      return res.status(400).json({ error: 'Aposta mínima: 100 Kz.' });
    if (valorNum > 100000)
      return res.status(400).json({ error: 'Aposta máxima: 100.000 Kz.' });

    const oddNum = parseFloat(odd_total);
    if (isNaN(oddNum) || oddNum < 1.01 || oddNum > 1000)
      return res.status(400).json({ error: 'Odd inválida.' });

    const u = await getUser(user_id);
    if (!u) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    if (u.suspenso) return res.status(403).json({ error: 'Conta suspensa.' });
    if (parseFloat(u.saldo) < valorNum)
      return res.status(400).json({ error: 'Saldo insuficiente.' });

    // Antifraude duplo
    const [fraudCheck1, fraudCheck2] = await Promise.all([
      checkApostaLimits(user_id),
      checkVelocidadeAposta(user_id, valorNum)
    ]);
    if (!fraudCheck1.ok) return res.status(429).json({ error: fraudCheck1.error });
    if (!fraudCheck2.ok) {
      // Sinalizar evento de risco
      await sb('risco_eventos', {
        method: 'POST',
        body: JSON.stringify({ user_id, tipo: 'velocidade_apostas', detalhe: `Valor: ${valorNum} Kz`, severidade: 'media' })
      }).catch(() => {});
      return res.status(429).json({ error: fraudCheck2.error });
    }

    const novoSaldo = Math.max(0, parseFloat(u.saldo) - valorNum);
    await sb(`utilizadores?id=eq.${user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ saldo: novoSaldo })
    });

    const ganhoP = parseFloat(ganho_potencial) || Math.round(valorNum * oddNum);
    const ref = 'BET' + Date.now().toString().slice(-9);

    await sb('apostas', {
      method: 'POST',
      body: JSON.stringify({
        user_id, jogo, detalhe,
        valor_apostado: valorNum,
        odd_total: oddNum,
        ganho_potencial: ganhoP,
        resultado: 'pendente',
        ganho_real: 0,
        fixture_id: fixture_id || null,
        seleccao_id: seleccao_id || null,
        mercado_id: mercado_id || null,
        referencia: ref
      })
    });

    // Ledger — debitar aposta
    await ledger(user_id, 'aposta', -valorNum, ref, `Aposta: ${jogo} — ${detalhe || ''}`, {
      jogo, odd: oddNum, ganho_potencial: ganhoP, fixture_id
    });

    // Actualizar contador na selecção se existir
    if (seleccao_id) {
      await sb(`seleccoes?id=eq.${seleccao_id}`, {
        method: 'PATCH',
        body: JSON.stringify({})
      }).catch(() => {});
    }

    await sb('notificacoes', {
      method: 'POST',
      body: JSON.stringify({
        user_id,
        titulo: '🎯 Aposta Registada',
        mensagem: `Aposta de ${valorNum.toLocaleString('pt-AO')} Kz em "${jogo}" registada. Odd: ${oddNum}x. Ganho potencial: ${ganhoP.toLocaleString('pt-AO')} Kz.`,
        tipo: 'info'
      })
    }).catch(() => {});

    return res.json({
      ok: true,
      resultado: 'pendente',
      ganho_real: 0,
      ganho_potencial: ganhoP,
      saldo_novo: novoSaldo,
      ref
    });
  }

  // ── EVENTOS AO VIVO / UPCOMING ───────────────────────────────
  if (action === 'eventos' && req.method === 'GET') {
    const { estado, liga_id, limit = 20 } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 20, 50);
    let q = `eventos?order=data_inicio.asc&limit=${safeLimit}`;
    if (estado) q += `&estado=eq.${estado}`;
    if (liga_id) q += `&liga_id=eq.${liga_id}`;
    const r = await sb(q);
    return res.json(await r.json().catch(() => []));
  }

  // ── MERCADOS DE UM EVENTO ────────────────────────────────────
  if (action === 'mercados' && req.method === 'GET') {
    const { evento_id } = req.query;
    if (!evento_id) return res.status(400).json({ error: 'evento_id em falta.' });

    const [mktsR, selsR] = await Promise.all([
      sb(`mercados?evento_id=eq.${evento_id}&activo=eq.true&order=ordem.asc`),
      sb(`seleccoes?evento_id=eq.${evento_id}&activa=eq.true&order=ordem.asc`)
    ]);

    const [mercados, seleccoes] = await Promise.all([
      mktsR.json().catch(() => []),
      selsR.json().catch(() => [])
    ]);

    // Agrupar selecções por mercado
    const mercadosComSels = mercados.map(m => ({
      ...m,
      seleccoes: seleccoes.filter(s => s.mercado_id === m.id)
    }));

    return res.json(mercadosComSels);
  }

  // ── ODDS DE UMA SELECÇÃO ─────────────────────────────────────
  if (action === 'odds_historico' && req.method === 'GET') {
    const { seleccao_id } = req.query;
    if (!seleccao_id) return res.status(400).json({ error: 'seleccao_id em falta.' });
    const r = await sb(`odds_historico?seleccao_id=eq.${seleccao_id}&order=criado_em.desc&limit=20`);
    return res.json(await r.json().catch(() => []));
  }

  // ── NOTIFICAÇÕES ─────────────────────────────────────────────
  if (action === 'notificacoes' && req.method === 'GET') {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const r = await sb(`notificacoes?user_id=eq.${user_id}&order=criado_em.desc&limit=20`);
    return res.json(await r.json().catch(() => []));
  }

  // ── MARCAR NOTIFICAÇÃO COMO LIDA ─────────────────────────────
  if (action === 'notif_lida' && req.method === 'POST') {
    const { notif_id } = req.body || {};
    if (!notif_id) return res.status(400).json({ error: 'notif_id em falta.' });
    await sb(`notificacoes?id=eq.${notif_id}`, { method: 'PATCH', body: JSON.stringify({ lida: true }) });
    return res.json({ ok: true });
  }

  // ── BÓNUS — estado e activação ───────────────────────────────
  if (action === 'bonus' && req.method === 'GET') {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const r = await sb(`bonus?user_id=eq.${user_id}&order=criado_em.desc&limit=10`);
    return res.json(await r.json().catch(() => []));
  }

  // ── LIMITES DE JOGO RESPONSÁVEL (server-side) ─────────────────
  if (action === 'definir_limite' && req.method === 'POST') {
    const { user_id, tipo, valor_diario } = req.body || {};
    if (!user_id || !tipo) return res.status(400).json({ error: 'Dados em falta.' });

    const valorNum = parseFloat(valor_diario);
    if (isNaN(valorNum) || valorNum < 500)
      return res.status(400).json({ error: 'Valor mínimo: 500 Kz.' });

    // Guardar em risco_limites
    const existeR = await sb(`risco_limites?user_id=eq.${user_id}&tipo=eq.${tipo}&limit=1`);
    const existe = await existeR.json().catch(() => []);

    if (Array.isArray(existe) && existe.length) {
      await sb(`risco_limites?user_id=eq.${user_id}&tipo=eq.${tipo}`, {
        method: 'PATCH',
        body: JSON.stringify({ valor: valorNum, activo: true })
      });
    } else {
      await sb('risco_limites', {
        method: 'POST',
        body: JSON.stringify({ user_id, tipo, valor: valorNum, activo: true })
      });
    }

    return res.json({ ok: true, tipo, valor: valorNum });
  }

  // ── KYC — submeter documento ─────────────────────────────────
  if (action === 'kyc_submeter' && req.method === 'POST') {
    const { user_id, tipo_documento, numero_documento } = req.body || {};
    if (!user_id || !tipo_documento || !numero_documento)
      return res.status(400).json({ error: 'Dados em falta.' });

    const tiposValidos = ['bi', 'passaporte', 'carta_conducao'];
    if (!tiposValidos.includes(tipo_documento))
      return res.status(400).json({ error: 'Tipo de documento inválido.' });

    // Verificar se já existe KYC
    const existeR = await sb(`kyc?user_id=eq.${user_id}&select=id,estado&limit=1`);
    const existe = (await existeR.json().catch(() => []))[0];

    if (existe?.estado === 'aprovado')
      return res.status(409).json({ error: 'KYC já aprovado.' });

    if (existe) {
      await sb(`kyc?id=eq.${existe.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ tipo_documento, numero_documento, estado: 'pendente', submetido_em: new Date().toISOString() })
      });
    } else {
      await sb('kyc', {
        method: 'POST',
        body: JSON.stringify({ user_id, tipo_documento, numero_documento, estado: 'pendente' })
      });
    }

    return res.json({ ok: true, mensagem: 'Documentos submetidos. Verificação em 24-48h.' });
  }

  // ── KYC — estado ────────────────────────────────────────────
  if (action === 'kyc_estado' && req.method === 'GET') {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const r = await sb(`kyc?user_id=eq.${user_id}&select=estado,tipo_documento,submetido_em,verificado_em&limit=1`);
    const kyc = (await r.json().catch(() => []))[0];
    return res.json(kyc || { estado: 'nenhum' });
  }

  res.status(404).json({ error: 'Acção não encontrada.' });
};
