// api/transacoes.js — OnlyBet v2 — Antifraude no servidor + validações reforçadas
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

// ── ANTIFRAUDE NO SERVIDOR ────────────────────────────────────
// Verifica limites de depósito (5/hora, 500k Kz/hora)
async function checkDepositoLimits(user_id, valor) {
  const umHoraAtras = new Date(Date.now() - 3600000).toISOString();
  const r = await sb(`depositos_pendentes?user_id=eq.${user_id}&criado_em=gte.${umHoraAtras}&select=valor`);
  const deps = await r.json();
  if (!Array.isArray(deps)) return { ok: true };
  if (deps.length >= 5) return { ok: false, error: 'Limite de 5 depósitos por hora atingido.' };
  const totalHora = deps.reduce((s, d) => s + parseFloat(d.valor || 0), 0);
  if (totalHora + valor > 500000) return { ok: false, error: 'Limite de 500.000 Kz por hora atingido.' };
  return { ok: true };
}

// Verifica limite de levantamentos (1/hora)
async function checkLevantamentoLimits(user_id) {
  const umHoraAtras = new Date(Date.now() - 3600000).toISOString();
  const r = await sb(`transacoes?user_id=eq.${user_id}&tipo=eq.levantamento&criado_em=gte.${umHoraAtras}&select=id`);
  const levs = await r.json();
  if (Array.isArray(levs) && levs.length >= 1)
    return { ok: false, error: 'Limite de 1 levantamento por hora. Tenta mais tarde.' };
  return { ok: true };
}

// Verifica limite de apostas (10/minuto)
async function checkApostaLimits(user_id) {
  const umMinutoAtras = new Date(Date.now() - 60000).toISOString();
  const r = await sb(`apostas?user_id=eq.${user_id}&criado_em=gte.${umMinutoAtras}&select=id`);
  const aps = await r.json();
  if (Array.isArray(aps) && aps.length >= 10)
    return { ok: false, error: 'Demasiadas apostas em pouco tempo. Aguarda um momento.' };
  return { ok: true };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action } = req.query;

  // ── HISTÓRICO ────────────────────────────────────────────────
  if (action === 'historico' && req.method === 'GET') {
    const { user_id, limit = 50 } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const safeLimit = Math.min(parseInt(limit) || 50, 100);
    const r = await sb(`transacoes?user_id=eq.${user_id}&order=criado_em.desc&limit=${safeLimit}`);
    return res.json(await r.json());
  }

  // ── APOSTAS DO UTILIZADOR ────────────────────────────────────
  if (action === 'apostas_user' && req.method === 'GET') {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const r = await sb(`apostas?user_id=eq.${user_id}&order=criado_em.desc&limit=30`);
    return res.json(await r.json());
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

    // Verificar utilizador existe e não está suspenso
    const ur = await sb(`utilizadores?id=eq.${user_id}&select=id,suspenso&limit=1`);
    const u = (await ur.json())[0];
    if (!u) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    if (u.suspenso) return res.status(403).json({ error: 'Conta suspensa.' });

    // Antifraude no servidor
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

    // Notificar utilizador
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

    const ur = await sb(`utilizadores?id=eq.${user_id}&select=saldo,suspenso&limit=1`);
    const u = (await ur.json())[0];
    if (!u) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    if (u.suspenso) return res.status(403).json({ error: 'Conta suspensa.' });
    if (parseFloat(u.saldo) < valorNum)
      return res.status(400).json({ error: 'Saldo insuficiente.' });

    // Antifraude
    const fraudCheck = await checkLevantamentoLimits(user_id);
    if (!fraudCheck.ok) return res.status(429).json({ error: fraudCheck.error });

    // Debitar saldo (fica em hold até aprovação)
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
    const { user_id, jogo, detalhe, valor_apostado, odd_total, ganho_potencial } = req.body || {};

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

    const ur = await sb(`utilizadores?id=eq.${user_id}&select=saldo,suspenso&limit=1`);
    const u = (await ur.json())[0];
    if (!u) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    if (u.suspenso) return res.status(403).json({ error: 'Conta suspensa.' });
    if (parseFloat(u.saldo) < valorNum)
      return res.status(400).json({ error: 'Saldo insuficiente.' });

    // Antifraude apostas
    const fraudCheck = await checkApostaLimits(user_id);
    if (!fraudCheck.ok) return res.status(429).json({ error: fraudCheck.error });

    // Debitar saldo
    const novoSaldo = Math.max(0, parseFloat(u.saldo) - valorNum);
    await sb(`utilizadores?id=eq.${user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ saldo: novoSaldo })
    });

    // Aposta fica PENDENTE — será resolvida pelo admin quando o jogo terminar
    await sb('apostas', {
      method: 'POST',
      body: JSON.stringify({
        user_id, jogo, detalhe,
        valor_apostado: valorNum,
        odd_total: oddNum,
        ganho_potencial: parseFloat(ganho_potencial) || Math.round(valorNum * oddNum),
        resultado: 'pendente',
        ganho_real: 0
      })
    });

    // Notificar utilizador que a aposta foi registada
    await sb('notificacoes', {
      method: 'POST',
      body: JSON.stringify({
        user_id,
        titulo: '🎯 Aposta Registada',
        mensagem: `Aposta de ${valorNum.toLocaleString('pt-AO')} Kz em "${jogo}" registada. Odd: ${oddNum}x. Ganho potencial: ${Math.round(valorNum * oddNum).toLocaleString('pt-AO')} Kz.`,
        tipo: 'info'
      })
    }).catch(() => {});

    return res.json({
      ok: true,
      resultado: 'pendente',
      ganho_real: 0,
      saldo_novo: novoSaldo
    });
  }

  // ── NOTIFICAÇÕES ─────────────────────────────────────────────
  if (action === 'notificacoes' && req.method === 'GET') {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const r = await sb(`notificacoes?user_id=eq.${user_id}&order=criado_em.desc&limit=20`);
    return res.json(await r.json());
  }

  // ── MARCAR NOTIFICAÇÃO COMO LIDA ─────────────────────────────
  if (action === 'notif_lida' && req.method === 'POST') {
    const { notif_id } = req.body || {};
    if (!notif_id) return res.status(400).json({ error: 'notif_id em falta.' });
    await sb(`notificacoes?id=eq.${notif_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ lida: true })
    });
    return res.json({ ok: true });
  }

  res.status(404).json({ error: 'Acção não encontrada.' });
};
