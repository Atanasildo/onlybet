// api/betting.js — OnlyBet Motor de Apostas v1
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET;
const FOOTBALL_KEY = process.env.FOOTBALL_API_KEY || 'eaad211e17510f381a6c81d376509476';
const HOUSE_EDGE = 0.08;

const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
  headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': opts.prefer || 'return=representation', ...opts.headers }, ...opts
});

function probToOdd(prob, edge = HOUSE_EDGE) {
  const adjProb = Math.min(0.97, Math.max(0.01, prob * (1 + edge)));
  return Math.round((1 / adjProb) * 100) / 100;
}

function calcOdds1X2(homeStrength, awayStrength) {
  const total = homeStrength + awayStrength + 0.3;
  return {
    casa: probToOdd(homeStrength / total),
    empate: probToOdd(0.3 / total),
    fora: probToOdd(awayStrength / total)
  };
}

async function ajustarOddsPorVolume(seleccaoId, oddActual) {
  const r = await sb(`apostas?seleccao_id=eq.${seleccaoId}&resultado=eq.pendente&select=valor_apostado`);
  const apostas = await r.json();
  if (!Array.isArray(apostas) || apostas.length < 5) return oddActual;
  const volume = apostas.reduce((s, a) => s + parseFloat(a.valor_apostado || 0), 0);
  if (volume > 500000) return Math.max(1.01, Math.round(oddActual * 0.97 * 100) / 100);
  if (volume > 200000) return Math.max(1.01, Math.round(oddActual * 0.99 * 100) / 100);
  return oddActual;
}

async function importarJogos() {
  try {
    const [liveR, nextR] = await Promise.all([
      fetch('https://v3.football.api-sports.io/fixtures?live=all', { headers: { 'x-apisports-key': FOOTBALL_KEY } }),
      fetch('https://v3.football.api-sports.io/fixtures?next=20', { headers: { 'x-apisports-key': FOOTBALL_KEY } })
    ]);
    const liveFixtures = (await liveR.json())?.response || [];
    const nextFixtures = (await nextR.json())?.response || [];
    const allFixtures = [...liveFixtures, ...nextFixtures];
    let criados = 0, actualizados = 0;
    const estadoMap = { 'NS':'upcoming','TBD':'upcoming','1H':'live','HT':'live','2H':'live','ET':'live','P':'live','BT':'live','FT':'finished','AET':'finished','PEN':'finished','SUSP':'suspended','PST':'suspended','CANC':'cancelled','WO':'finished','AWD':'finished' };

    for (const f of allFixtures.slice(0, 30)) {
      const { fixture: fix, teams, goals, league } = f;
      const estado = estadoMap[fix?.status?.short] || 'upcoming';
      const eventoData = {
        fixture_id: fix.id, liga: `${league.name} — ${league.country}`, liga_logo: league.logo,
        equipa_casa: teams.home.name, equipa_fora: teams.away.name,
        equipa_casa_logo: teams.home.logo, equipa_fora_logo: teams.away.logo,
        data_inicio: new Date(fix.date).toISOString(), estado,
        minuto: fix?.status?.elapsed || null, golos_casa: goals?.home || 0, golos_fora: goals?.away || 0,
        actualizado_em: new Date().toISOString()
      };
      if (estado === 'finished') {
        eventoData.resultado_casa = goals?.home || 0; eventoData.resultado_fora = goals?.away || 0;
        eventoData.vencedor = goals?.home > goals?.away ? 'home' : goals?.away > goals?.home ? 'away' : 'draw';
      }
      const exist = await (await sb(`eventos?fixture_id=eq.${fix.id}&select=id&limit=1`)).json();
      let eventoId;
      if (exist.length) {
        eventoId = exist[0].id;
        await sb(`eventos?fixture_id=eq.${fix.id}`, { method: 'PATCH', body: JSON.stringify(eventoData) });
        actualizados++;
      } else {
        const ne = (await (await sb('eventos', { method: 'POST', body: JSON.stringify(eventoData) })).json())[0];
        eventoId = ne?.id; criados++;
        if (eventoId && estado !== 'finished') await criarMercados(eventoId, teams);
      }
      if (estado === 'finished' && eventoId) await resolverApostasEvento(eventoId, eventoData.vencedor, eventoData.resultado_casa, eventoData.resultado_fora);
    }
    return { criados, actualizados, total: allFixtures.length };
  } catch (e) { return { erro: e.message }; }
}

async function criarMercados(eventoId, teams) {
  const homeStr = 0.5 + Math.random() * 0.3, awayStr = 1 - homeStr;
  const odds1x2 = calcOdds1X2(homeStr, awayStr);
  const m1x2 = (await (await sb('mercados', { method: 'POST', body: JSON.stringify({ evento_id: eventoId, tipo: '1x2', nome: 'Resultado Final 1X2' }) })).json())[0];
  if (m1x2?.id) await sb('seleccoes', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([
    { mercado_id: m1x2.id, evento_id: eventoId, nome: `${teams.home.name} (Casa)`, odd: odds1x2.casa, probabilidade: 1/odds1x2.casa },
    { mercado_id: m1x2.id, evento_id: eventoId, nome: 'Empate', odd: odds1x2.empate, probabilidade: 1/odds1x2.empate },
    { mercado_id: m1x2.id, evento_id: eventoId, nome: `${teams.away.name} (Fora)`, odd: odds1x2.fora, probabilidade: 1/odds1x2.fora }
  ]) });
  const overProb = 0.45 + Math.random() * 0.15;
  const ou = (await (await sb('mercados', { method: 'POST', body: JSON.stringify({ evento_id: eventoId, tipo: 'over_under', nome: 'Total de Golos 2.5' }) })).json())[0];
  if (ou?.id) await sb('seleccoes', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([
    { mercado_id: ou.id, evento_id: eventoId, nome: 'Mais de 2.5 Golos', odd: probToOdd(overProb), probabilidade: overProb },
    { mercado_id: ou.id, evento_id: eventoId, nome: 'Menos de 2.5 Golos', odd: probToOdd(1 - overProb), probabilidade: 1 - overProb }
  ]) });
  const simProb = 0.5 + Math.random() * 0.1;
  const bm = (await (await sb('mercados', { method: 'POST', body: JSON.stringify({ evento_id: eventoId, tipo: 'ambas_marcam', nome: 'Ambas as Equipas Marcam' }) })).json())[0];
  if (bm?.id) await sb('seleccoes', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([
    { mercado_id: bm.id, evento_id: eventoId, nome: 'Sim', odd: probToOdd(simProb), probabilidade: simProb },
    { mercado_id: bm.id, evento_id: eventoId, nome: 'Não', odd: probToOdd(1 - simProb), probabilidade: 1 - simProb }
  ]) });
}

async function resolverApostasEvento(eventoId, vencedor, golasCasa, golasFora) {
  const seleccoes = await (await sb(`seleccoes?evento_id=eq.${eventoId}&select=id,nome,mercado_id`)).json();
  if (!Array.isArray(seleccoes)) return;
  const mercados = await (await sb(`mercados?evento_id=eq.${eventoId}&select=id,tipo`)).json();
  const mercadoMap = Object.fromEntries((mercados||[]).map(m => [m.id, m.tipo]));
  for (const sel of seleccoes) {
    const tipo = mercadoMap[sel.mercado_id]; let vencedora = false;
    const total = (golasCasa||0) + (golasFora||0), n = (sel.nome||'').toLowerCase();
    if (tipo === '1x2') { if (vencedor==='home'&&n.includes('casa')) vencedora=true; else if (vencedor==='draw'&&n.includes('empate')) vencedora=true; else if (vencedor==='away'&&n.includes('fora')) vencedora=true; }
    else if (tipo === 'over_under') { if (n.includes('mais de 2.5')&&total>2.5) vencedora=true; else if (n.includes('menos de 2.5')&&total<2.5) vencedora=true; }
    else if (tipo === 'ambas_marcam') { const bm=golasCasa>0&&golasFora>0; if (sel.nome==='Sim'&&bm) vencedora=true; else if (sel.nome==='Não'&&!bm) vencedora=true; }
    await sb(`seleccoes?id=eq.${sel.id}`, { method: 'PATCH', body: JSON.stringify({ vencedora }) });
    if (vencedora) {
      const apostas = await (await sb(`apostas?seleccao_id=eq.${sel.id}&resultado=eq.pendente&select=*`)).json();
      for (const a of (apostas||[])) {
        const ganho = Math.round(parseFloat(a.valor_apostado)*parseFloat(a.odd_total||1));
        await sb(`apostas?id=eq.${a.id}`, { method: 'PATCH', body: JSON.stringify({ resultado:'ganhou', ganho_real:ganho, resolvida_em:new Date().toISOString() }) });
        const u = (await (await sb(`utilizadores?id=eq.${a.user_id}&select=saldo&limit=1`)).json())[0];
        if (u) {
          const ns = parseFloat(u.saldo||0)+ganho;
          await sb(`utilizadores?id=eq.${a.user_id}`, { method: 'PATCH', body: JSON.stringify({ saldo:ns }) });
          await sb('notificacoes', { method:'POST', body:JSON.stringify({ user_id:a.user_id, titulo:'🎉 Aposta Ganha!', mensagem:`Ganhou ${ganho.toLocaleString('pt-AO')} Kz na aposta "${a.jogo}"!`, tipo:'sucesso' }) });
        }
      }
    }
  }
  await sb(`mercados?evento_id=eq.${eventoId}`, { method:'PATCH', body:JSON.stringify({ resolvido:true }) });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const { action } = req.query;

  if (action === 'eventos' && req.method === 'GET') {
    const { estado = 'upcoming', limit = 20 } = req.query;
    const r = await sb(`eventos?estado=eq.${estado}&order=data_inicio.asc&limit=${Math.min(parseInt(limit)||20,50)}&select=*`);
    return res.json(await r.json());
  }
  if (action === 'evento' && req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'ID em falta.' });
    const [er, mr] = await Promise.all([sb(`eventos?id=eq.${id}&limit=1`), sb(`mercados?evento_id=eq.${id}&resolvido=eq.false&order=tipo.asc`)]);
    const evento = (await er.json())[0];
    if (!evento) return res.status(404).json({ error: 'Evento não encontrado.' });
    const mercados = await mr.json();
    const mercadosComSel = await Promise.all((mercados||[]).map(async m => {
      const sr = await sb(`seleccoes?mercado_id=eq.${m.id}&order=odd.asc`);
      return { ...m, seleccoes: await sr.json() };
    }));
    return res.json({ ...evento, mercados: mercadosComSel });
  }
  if (action === 'odds' && req.method === 'GET') {
    const { seleccao_id } = req.query;
    if (!seleccao_id) return res.status(400).json({ error: 'seleccao_id em falta.' });
    const s = (await (await sb(`seleccoes?id=eq.${seleccao_id}&select=*&limit=1`)).json())[0];
    if (!s) return res.status(404).json({ error: 'Não encontrado.' });
    return res.json({ ...s, odd: await ajustarOddsPorVolume(seleccao_id, s.odd) });
  }
  if (action === 'importar' && req.method === 'POST') {
    const secret = req.headers['x-cron-secret'];
    if (secret !== (process.env.CRON_SECRET || 'onlybet_cron_2025')) return res.status(401).json({ error: 'Não autorizado.' });
    return res.json({ ok: true, ...(await importarJogos()) });
  }
  if (action === 'pesquisar' && req.method === 'GET') {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const r = await sb(`eventos?or=(equipa_casa.ilike.*${encodeURIComponent(q)}*,equipa_fora.ilike.*${encodeURIComponent(q)}*)&estado=neq.cancelled&limit=10&select=id,equipa_casa,equipa_fora,liga,data_inicio,estado`);
    return res.json(await r.json());
  }
  res.status(404).json({ error: 'Acção não encontrada.' });
};
