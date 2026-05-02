// api/deposito.js — OnlyBet v2 — Endpoint de depósito legado
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido.' }); return; }

  try {
    const { userId, valor, metodo } = req.body || {};

    if (!valor || isNaN(parseFloat(valor)) || parseFloat(valor) < 500)
      return res.status(400).json({ error: 'Valor inválido. Mínimo: 500 Kz.' });

    const ref = 'OB-' + Date.now().toString().slice(-7);
    const conta = process.env.CONTA_PAGAMENTO || '976 036 278';

    const metNomes = { unitel: 'Unitel Money', paypay: 'PayPay Angola', multicaixa: 'Multicaixa Express' };
    const metSel = metodo || 'unitel';

    res.status(200).json({
      ok: true,
      ref,
      contaDestino: conta,
      metodo: metNomes[metSel] || metNomes.unitel,
      valor: parseFloat(valor),
      instrucoes: `Transfere ${parseFloat(valor).toLocaleString('pt-AO')} Kz via ${metNomes[metSel] || 'Unitel Money'} para ${conta}. Referência: ${ref}`
    });
  } catch (e) {
    console.error('Deposito error:', e);
    res.status(400).json({ error: 'Pedido inválido.' });
  }
};
