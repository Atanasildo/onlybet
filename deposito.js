// api/deposito.js — Registo de pedidos de depósito
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido.' }); return; }

  try {
    const { userId, userName, userPhone, valor, metodo } = req.body;
    const ref = 'OB-' + Date.now().toString().slice(-7);

    // Contas de destino (os TEUS números)
    const contas = {
      unitel: '976 036 278',
      paypay: '976 036 278'
    };

    res.status(200).json({
      ok: true,
      ref,
      contaDestino: contas[metodo] || contas.unitel,
      metodo,
      valor,
      instrucoes: metodo === 'unitel'
        ? `Transfere ${valor} Kz via Unitel Money para ${contas.unitel}. Referência: ${ref}`
        : `Transfere ${valor} Kz via PayPay para ${contas.paypay}. Referência: ${ref}`
    });
  } catch (e) {
    res.status(400).json({ error: 'Pedido inválido.' });
  }
}
