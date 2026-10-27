import fs from 'node:fs';

const TOKEN = process.env.BRAPI_TOKEN;
if (!TOKEN) {
  console.error('BRAPI_TOKEN ausente');
  process.exit(1);
}
const BASE = 'https://brapi.dev';
const REPO = process.env.GITHUB_REPOSITORY || 'Tbrussolo/painel';
const avisos = [];
const agora = new Date();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

async function brapi(caminho, params) {
  const url = new URL(BASE + caminho);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  for (let t = 0; t < 3; t++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (r.status === 429) {
      const espera = Number(r.headers.get('retry-after')) || 5;
      await dormir(Math.min(espera, 30) * 1000);
      continue;
    }
    if (r.status === 401) throw new Error('401 chave ausente ou invalida');
    if (r.status === 403) throw new Error('403 plano sem acesso a ' + caminho);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.status + ' em ' + caminho);
    return r.json();
  }
  throw new Error('429 limite excedido em ' + caminho);
}

async function seguro(rotulo, fn, padrao) {
  try {
    return await fn();
  } catch (e) {
    avisos.push(rotulo + ': ' + e.message);
    return padrao;
  }
}

async function cotar(simbolos, tam) {
  const saida = {};
  for (let i = 0; i < simbolos.length; i += tam) {
    const parte = simbolos.slice(i, i + tam);
    const j = await brapi('/api/v2/stocks/quote', { symbols: parte.join(',') });
    ((j && j.results) || []).forEach((r) => {
      saida[r.requestedSymbol] = r.data;
      if (!saida[r.symbol]) saida[r.symbol] = r.data;
    });
  }
  return saida;
}

async function cotarComFallback(simbolos) {
  try {
    return await cotar(simbolos, 20);
  } catch (e) {
    avisos.push('cotacao em lote: ' + e.message);
    if (/^(401|403|429)/.test(e.message) || simbolos.length > 10) return {};
    const saida = {};
    for (const s of simbolos) {
      try {
        Object.assign(saida, await cotar([s], 1));
      } catch (e2) {
        avisos.push('cotacao ' + s + ': ' + e2.message);
      }
    }
    return saida;
  }
}

function linhaB3(nome, d) {
  if (!d) return { nome, erro: true };
  return {
    nome,
    min: num(d.regularMarketDayLow),
    max: num(d.regularMarketDayHigh),
    atual: num(d.regularMarketPrice),
    var: num(d.regularMarketChange),
    varPct: num(d.regularMarketChangePercent),
  };
}

async function extremos() {
  const alt = await brapi('/api/v2/stocks/screener', { sortBy: 'changePercent', sortOrder: 'desc', limit: '5' });
  const bai = await brapi('/api/v2/stocks/screener', { sortBy: 'changePercent', sortOrder: 'asc', limit: '5' });
  const A = (alt && alt.results) || [];
  const B = (bai && bai.results) || [];
  const simbolos = A.concat(B).map((x) => x.symbol);
  const cot = await seguro('cotacao altas e baixas', () => cotarComFallback(simbolos), {});
  const monta = (x) => {
    const d = cot[x.symbol];
    if (d) return linhaB3(x.symbol, d);
    return {
      nome: x.symbol,
      min: null,
      max: null,
      atual: num(x.quote && x.quote.lastPrice),
      var: null,
      varPct: num(x.quote && x.quote.changePercent),
    };
  };
  return { altas: A.map(monta), baixas: B.map(monta) };
}

const PARES = [
  ['Dólar', 'USD-BRL'],
  ['Euro', 'EUR-BRL'],
  ['Libra', 'GBP-BRL'],
  ['Iene', 'JPY-BRL'],
  ['Yuan', 'CNY-BRL'],
];

async function moedas() {
  const saida = [];
  let bloqueado = false;
  for (const [nome, par] of PARES) {
    if (bloqueado) {
      saida.push({ nome, erro: true });
      continue;
    }
    try {
      const j = await brapi('/api/v2/currency', { currency: par });
      const c = j && j.currency && j.currency[0];
      if (!c) {
        saida.push({ nome, erro: true });
        continue;
      }
      saida.push({
        nome,
        min: num(c.low),
        max: num(c.high),
        atual: num(c.bidPrice),
        var: num(c.bidVariation),
        varPct: num(c.percentageChange),
      });
    } catch (e) {
      avisos.push('cambio ' + par + ': ' + e.message);
      if (/^(401|403)/.test(e.message)) bloqueado = true;
      saida.push({ nome, erro: true });
    }
  }
  return saida;
}

async function yahoo(simbolo, range, intervalo) {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(simbolo) +
    '?range=' + range + '&interval=' + intervalo;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; painel-tv)' } });
  if (!r.ok) throw new Error('Yahoo ' + r.status + ' ' + simbolo);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('Yahoo sem dados ' + simbolo);
  return res;
}

const INTL = [
  ['S&P 500', '^GSPC'],
  ['Nasdaq', '^IXIC'],
  ['Dow Jones', '^DJI'],
  ['Nikkei', '^N225'],
  ['Xangai', '000001.SS'],
  ['Hang Seng', '^HSI'],
  ['Euro Stoxx 50', '^STOXX50E'],
  ['DAX', '^GDAXI'],
];

async function internacionais() {
  const saida = [];
  for (const [nome, simbolo] of INTL) {
    try {
      const d = await yahoo(simbolo, '1mo', '1d');
      const m = d.meta || {};
      const ts = d.timestamp || [];
      const cl = (d.indicators && d.indicators.quote && d.indicators.quote[0] && d.indicators.quote[0].close) || [];
      const dia = (x) => new Date((x + (m.gmtoffset || 0)) * 1000).toISOString().slice(0, 10);
      const diaAtual = dia(m.regularMarketTime);
      let anterior = null;
      for (let i = ts.length - 1; i >= 0; i--) {
        if (cl[i] !== null && cl[i] !== undefined && dia(ts[i]) < diaAtual) {
          anterior = cl[i];
          break;
        }
      }
      const atual = num(m.regularMarketPrice);
      const variacao = atual !== null && anterior !== null ? atual - anterior : null;
      saida.push({
        nome,
        min: num(m.regularMarketDayLow),
        max: num(m.regularMarketDayHigh),
        atual,
        var: variacao,
        varPct: variacao !== null ? (variacao / anterior) * 100 : null,
      });
    } catch (e) {
      avisos.push(nome + ': ' + e.message);
      saida.push({ nome, erro: true });
    }
  }
  return saida;
}

async function graficoIbov() {
  const pega = async (range, intervalo) => {
    const j = await brapi('/api/v2/stocks/historical', { symbols: '^BVSP', range, interval: intervalo, sortOrder: 'asc' });
    const r = j && j.results && j.results[0];
    return (r && r.data && r.data.historicalDataPrice) || [];
  };
  let serie = await pega('7d', '1h').catch(() => []);
  if (!serie.length) serie = (await pega('1mo', '1d')).slice(-7);
  return serie.filter((p) => p.close !== null && p.close !== undefined).map((p) => [p.date * 1000, p.close]);
}

async function graficoUsd() {
  const fmtData = (d) => d.toISOString().slice(0, 10);
  const j = await brapi('/api/v2/currency/historical', {
    currency: 'USD-BRL',
    startDate: fmtData(new Date(Date.now() - 14 * 86400000)),
    endDate: fmtData(new Date()),
    sortOrder: 'asc',
  });
  const obs = (j && j.results && j.results[0] && j.results[0].observations) || [];
  obs.sort((a, b) => (a.date < b.date ? -1 : 1));
  return obs.slice(-7).map((o) => [Date.parse(o.date), o.value]);
}

async function graficoYahoo(simbolo) {
  const d = await yahoo(simbolo, '5d', '1h');
  const ts = d.timestamp || [];
  const cl = (d.indicators && d.indicators.quote && d.indicators.quote[0] && d.indicators.quote[0].close) || [];
  const pontos = [];
  for (let i = 0; i < ts.length; i++) {
    if (cl[i] !== null && cl[i] !== undefined) pontos.push([ts[i] * 1000, cl[i]]);
  }
  return pontos;
}

async function principal() {
  const anterior = await fetch('https://raw.githubusercontent.com/' + REPO + '/dados/data.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  const idx = await seguro('indices B3', () => cotarComFallback(['^BVSP', 'SMLL', 'SMLL.SA', 'IFIX.SA']), {});
  const pega = (lista) => {
    for (const s of lista) {
      if (idx[s]) return idx[s];
    }
    return null;
  };
  const indices = [
    linhaB3('Ibovespa', pega(['^BVSP'])),
    linhaB3('Small Caps', pega(['SMLL', 'SMLL.SA'])),
    linhaB3('IFIX', pega(['IFIX.SA'])),
  ];
  const ext = await seguro('altas e baixas', extremos, { altas: [], baixas: [] });
  const tabela2 = await internacionais();
  const tabela3 = await moedas();

  let tape = [];
  let lista = [];
  try {
    lista = JSON.parse(fs.readFileSync('ibovespa.json', 'utf8')).tickers || [];
  } catch (e) {
    avisos.push('ibovespa.json: ' + e.message);
  }
  if (lista.length) {
    const cot = await seguro('faixa Ibovespa', () => cotar(lista, 20), {});
    tape = lista
      .filter((s) => cot[s])
      .map((s) => ({ s, p: num(cot[s].regularMarketPrice), v: num(cot[s].regularMarketChangePercent) }));
  }

  let graficos = (anterior && anterior.graficos) || {};
  if (agora.getUTCMinutes() < 10 || !Object.keys(graficos).length) {
    const novo = {};
    const g1 = await seguro('grafico Ibovespa', graficoIbov, null);
    if (g1 && g1.length > 1) novo.ibov = { nome: 'Ibovespa', pontos: g1 };
    const g2 = await seguro('grafico S&P 500', () => graficoYahoo('^GSPC'), null);
    if (g2 && g2.length > 1) novo.sp = { nome: 'S&P 500', pontos: g2 };
    const g3 = await seguro('grafico Nasdaq', () => graficoYahoo('^IXIC'), null);
    if (g3 && g3.length > 1) novo.nasdaq = { nome: 'Nasdaq', pontos: g3 };
    const g4 = await seguro('grafico Dolar', graficoUsd, null);
    if (g4 && g4.length > 1) novo.usd = { nome: 'Dólar (R$)', pontos: g4 };
    graficos = Object.assign({}, graficos, novo);
  }

  const dados = {
    atualizadoEm: agora.toISOString(),
    tabela1: { indices, altas: ext.altas, baixas: ext.baixas },
    tabela2,
    tabela3,
    tape,
    graficos,
    avisos,
  };

  const falhou = indices.every((r) => r.erro) && tabela3.every((r) => r.erro);
  if (falhou && anterior) {
    anterior.avisos = avisos;
    fs.writeFileSync('data.json', JSON.stringify(anterior));
    console.log('Falha geral: mantidos os dados anteriores. Avisos:', avisos.length);
    return;
  }
  fs.writeFileSync('data.json', JSON.stringify(dados));
  console.log('OK. Avisos:', avisos.length);
  avisos.forEach((a) => console.log(' -', a));
}

principal().catch((e) => {
  console.error('Erro geral:', e.message);
  process.exit(1);
});
