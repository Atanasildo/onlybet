// api/transacoes.js — Depósitos, Levantamentos, Histórico via Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET;
const CONTA = process.env.CONTA_PAGAMENTO || '976 036 278';

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action } = req.query;

  // ── HISTÓRICO ────────────────────────────────────────────────
  if (action === 'historico' && req.method === 'GET') {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id em falta.' });
    const r = await sb(`transacoes?user_id=eq.${user_id}&order=criado_em.desc&limit=50`);
    return res.json(await r.json());
  }

  // ── INICIAR DEPÓSITO ─────────────────────────────────────────
  if (action === 'deposito' && req.method === 'POST') {
    const { user_id, valor, metodo, telefone } = req.body;
    if (!user_id || !valor || !metodo || !telefone)
      return res.status(400).json({ error: 'Dados incompletos.' });
    if (valor < 500) return res.status(400).json({ error: 'Mínimo: 500 Kz.' });
    if (!['unitel', 'paypay', 'multicaixa'].includes(metodo))
      return res.status(400).json({ error: 'Método de pagamento inválido.' });

    const ref = 'OB' + Date.now().toString().slice(-8);
    const metNomes = { unitel: 'Unitel Money', paypay: 'PayPay Angola', multicaixa: 'Multicaixa Express' };

    await sb('depositos_pendentes', {
      method: 'POST',
      body: JSON.stringify({ user_id, referencia: ref, valor, metodo, telefone, estado: 'aguarda' })
    });

    return res.json({
      ok: true, ref, conta: CONTA,
      metodo: metNomes[metodo],
      instrucao: `Transfere ${Number(valor).toLocaleString('pt-AO')} Kz para ${CONTA} via ${metNomes[metodo]}. Referência: ${ref}`
    });
  }

  // ── CONFIRMAR TRANSFERÊNCIA ──────────────────────────────────
  if (action === 'confirmar' && req.method === 'POST') {
    const { ref } = req.body;
    if (!ref) return res.status(400).json({ error: 'Referência em falta.' });

    // Verificar que existe e ainda não foi processado
    const dr = await sb(`depositos_pendentes?referencia=eq.${ref}&limit=1`);
    const dep = (await dr.json())[0];
    if (!dep) return res.status(404).json({ error: 'Depósito não encontrado.' });
    if (dep.estado !== 'aguarda') return res.status(409).json({ error: 'Este depósito já foi confirmado.' });

    await sb(`depositos_pendentes?referencia=eq.${ref}`, {
      method: 'PATCH',
      body: JSON.stringify({ estado: 'transferido' })
    });
    return res.json({ ok: true, mensagem: 'Confirmado. O admin irá verificar e creditar o saldo em breve.' });
  }

  // ── SOLICITAR LEVANTAMENTO ───────────────────────────────────
  if (action === 'levantamento' && req.method === 'POST') {
    const { user_id, valor, metodo, telefone } = req.body;
    if (!user_id || !valor || !metodo || !telefone)
      return res.status(400).json({ error: 'Dados incompletos.' });
    if (valor < 1000) return res.status(400).json({ error: 'Mínimo: 1.000 Kz.' });

    const ur = await sb(`utilizadores?id=eq.${user_id}&select=saldo,suspenso&limit=1`);
    const u = (await ur.json())[0];
    if (!u) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    if (u.suspenso) return res.status(403).json({ error: 'Conta suspensa.' });
    if (parseFloat(u.saldo) < valor) return res.status(400).json({ error: 'Saldo insuficiente.' });

    // Debitar saldo imediatamente (fica em hold)
    await sb(`utilizadores?id=eq.${user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ saldo: parseFloat(u.saldo) - valor })
    });

    const ref = 'LEV' + Date.now().toString().slice(-8);
    await sb('transacoes', {
      method: 'POST',
      body: JSON.stringify({ user_id, tipo: 'levantamento', metodo, valor, estado: 'pendente', referencia: ref, numero_telef: telefone })
    });
    await sb('notificacoes', {
      method: 'POST',
      body: JSON.stringify({ user_id, titulo: 'Levantamento solicitado', mensagem: `Pedido de ${Number(valor).toLocaleString('pt-AO')} Kz submetido. O processamento demora até 15 minutos.`, tipo: 'info' })
    });

    return res.json({ ok: true, ref, mensagem: 'Levantamento submetido. Receberás o pagamento em breve.' });
  }

  // ── REGISTAR APOSTA ──────────────────────────────────────────
  if (action === 'aposta' && req.method === 'POST') {
    const { user_id, jogo, detalhe, valor_apostado, odd_total, ganho_potencial, resultado, ganho_real } = req.body;
    if (!user_id || !valor_apostado || !jogo) return res.status(400).json({ error: 'Dados em falta.' });

    const ur = await sb(`utilizadores?id=eq.${user_id}&select=saldo,suspenso&limit=1`);
    const u = (await ur.json())[0];
    if (!u) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    if (u.suspenso) return res.status(403).json({ error: 'Conta suspensa.' });

    let novoSaldo = parseFloat(u.saldo || 0);

    // Debitar valor apostado (se não foi já debitado)
    if (resultado === 'pendente' || !resultado) {
      if (novoSaldo < valor_apostado) return res.status(400).json({ error: 'Saldo insuficiente.' });
      novoSaldo -= parseFloat(valor_apostado);
    }

    // Creditar ganho se ganhou
    if (resultado === 'ganhou') novoSaldo += parseFloat(ganho_real || 0);

    await sb(`utilizadores?id=eq.${user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ saldo: novoSaldo })
    });
    await sb('apostas', {
      method: 'POST',
      body: JSON.stringify({ user_id, jogo, detalhe, valor_apostado, odd_total, ganho_potencial, resultado: resultado || 'pendente', ganho_real: ganho_real || 0 })
    });

    return res.json({ ok: true, saldo_novo: novoSaldo });
  }

  res.status(404).json({ error: 'Acção não encontrada.' });
};