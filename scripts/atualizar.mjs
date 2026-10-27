import fs from 'node:fs';

const TOKEN = process.env.BRAPI_TOKEN;
if (!TOKEN) {
  console.error('BRAPI_TOKEN ausente');
  process.exit(1);
}
const BASE = 'https://brapi.dev';
const REPO = process.env.GITHUB_REPOSITORY || 'Tbrussolo/painel';
const UA = 'Mozilla/5.0 (compatible; painel-tv)';
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

async function emLotes(itens, tam, fn) {
  const saida = [];
  for (let i = 0; i < itens.length; i += tam) {
    const parte = itens.slice(i, i + tam);
    const r = await Promise.all(parte.map((x) => fn(x)));
    saida.push(...r);
    await dormir(300);
  }
  return saida;
}

function linhaBrapi(nome, d) {
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

function pick(nome, d) {
  return { nome, min: d.min, max: d.max, atual: d.atual, var: d.var, varPct: d.varPct };
}

async function cotarUm(simbolo) {
  const j = await brapi('/api/v2/stocks/quote', { symbols: simbolo });
  const r = j && j.results && j.results[0];
  return r ? r.data : null;
}

async function listaB3() {
  const j = await brapi('/api/quote/list', {});
  const itens = (j && j.stocks) || [];
  return itens.filter(
    (x) =>
      /^[A-Z]{4}(3|4|5|6|11)$/.test(x.stock) &&
      (x.subType === 'stock' || x.subType === 'unit') &&
      x.change !== null &&
      x.change !== undefined &&
      x.volume > 0,
  );
}

async function composicaoIbov() {
  const corpo = { language: 'pt-br', pageNumber: 1, pageSize: 120, index: 'IBOV', segment: '1' };
  const codigo = Buffer.from(JSON.stringify(corpo)).toString('base64');
  const r = await fetch('https://sistemaswebb3-listados.b3.com.br/indexProxy/indexCall/GetPortfolioDay/' + codigo, {
    headers: { 'User-Agent': UA },
  });
  if (!r.ok) throw new Error('B3 ' + r.status);
  const j = await r.json();
  const itens = (j && j.results) || [];
  return itens.map((x) => String(x.cod || '').trim()).filter(Boolean);
}

async function yahoo(simbolo, range, intervalo) {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(simbolo) +
    '?range=' + range + '&interval=' + intervalo;
  for (let t = 0; t < 2; t++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.status === 429 && t === 0) {
      await dormir(2000);
      continue;
    }
    if (!r.ok) throw new Error('Yahoo ' + r.status + ' ' + simbolo);
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res) throw new Error('Yahoo sem dados ' + simbolo);
    return res;
  }
  throw new Error('Yahoo falhou ' + simbolo);
}

async function yahooCotacao(simbolo) {
  const d = await yahoo(simbolo, '1d', '1d');
  const m = d.meta || {};
  const anterior = num(m.chartPreviousClose) !== null ? num(m.chartPreviousClose) : num(m.previousClose);
  const atual = num(m.regularMarketPrice);
  const variacao = atual !== null && anterior !== null ? atual - anterior : null;
  return {
    min: num(m.regularMarketDayLow),
    max: num(m.regularMarketDayHigh),
    atual,
    var: variacao,
    varPct: variacao !== null && anterior ? (variacao / anterior) * 100 : null,
    fonte: m.shortName || m.longName || '',
  };
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

async function tabelaYahoo(pares, rotulo) {
  const saida = [];
  for (const [nome, simbolo] of pares) {
    try {
      saida.push(pick(nome, await yahooCotacao(simbolo)));
    } catch (e) {
      avisos.push(rotulo + ' ' + nome + ': ' + e.message);
      saida.push({ nome, erro: true });
    }
  }
  return saida;
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

const MOEDAS = [
  ['Dólar', 'USDBRL=X'],
  ['Euro', 'EURBRL=X'],
  ['Libra', 'GBPBRL=X'],
  ['Iene', 'JPYBRL=X'],
  ['Yuan', 'CNYBRL=X'],
];

const GRAFICOS = [
  ['ibov', 'Ibovespa', '^BVSP'],
  ['sp', 'S&P 500', '^GSPC'],
  ['nasdaq', 'Nasdaq', '^IXIC'],
  ['usd', 'Dólar (R$)', 'USDBRL=X'],
];

async function principal() {
  const anterior = await fetch('https://raw.githubusercontent.com/' + REPO + '/dados/data.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  const dIbov = await seguro('Ibovespa (brapi)', () => cotarUm('^BVSP'), null);
  const dIfix = await seguro('IFIX (brapi)', () => cotarUm('IFIX.SA'), null);
  let small = null;
  for (const s of ['SMLL.SA', '^SMLL']) {
    try {
      const d = await yahooCotacao(s);
      if (/small|smll/i.test(d.fonte)) {
        small = d;
        break;
      }
      avisos.push('Small Caps: ' + s + ' retornou "' + d.fonte + '", descartado');
    } catch (e) {
      /* tenta o proximo simbolo */
    }
  }
  if (!small) avisos.push('Small Caps: sem cotacao confiavel');
  const indices = [
    linhaBrapi('Ibovespa', dIbov),
    small ? pick('Small Caps', small) : { nome: 'Small Caps', erro: true },
    linhaBrapi('IFIX', dIfix),
  ];

  const listaTodas = await seguro('lista de acoes da B3 (brapi)', listaB3, []);

  let tickers = await seguro('composicao do Ibovespa (B3)', composicaoIbov, []);
  if (!tickers.length) {
    try {
      tickers = JSON.parse(fs.readFileSync('ibovespa.json', 'utf8')).tickers || [];
    } catch (e) {
      tickers = [];
    }
    if (tickers.length) avisos.push('Ibovespa: usando ibovespa.json');
  }
  if (!tickers.length && listaTodas.length) {
    tickers = listaTodas
      .slice()
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 80)
      .map((x) => x.stock);
    avisos.push('faixa: composicao do Ibovespa indisponivel, usando as 80 acoes mais negociadas');
  }

  const cot = {};
  let semCotacao = 0;
  await emLotes(tickers, 6, async (s) => {
    try {
      cot[s] = await yahooCotacao(s + '.SA');
    } catch (e) {
      semCotacao++;
    }
  });
  if (semCotacao) avisos.push(semCotacao + ' acao(oes) sem cotacao no Yahoo');
  const tape = tickers.filter((s) => cot[s]).map((s) => ({ s, p: cot[s].atual, v: cot[s].varPct }));

  let altas = [];
  let baixas = [];
  if (listaTodas.length) {
    const ord = listaTodas.slice().sort((a, b) => b.change - a.change);
    const topo = ord.slice(0, 5);
    const fundo = ord.slice(-5).reverse();
    const faltam = topo.concat(fundo).map((x) => x.stock).filter((s) => !cot[s]);
    await emLotes(faltam, 5, async (s) => {
      try {
        cot[s] = await yahooCotacao(s + '.SA');
      } catch (e) {
        avisos.push('cotacao ' + s + ': ' + e.message);
      }
    });
    const monta = (x) =>
      cot[x.stock]
        ? pick(x.stock, cot[x.stock])
        : { nome: x.stock, min: null, max: null, atual: num(x.close), var: null, varPct: num(x.change) };
    altas = topo.map(monta).sort((a, b) => (b.varPct ?? -1e9) - (a.varPct ?? -1e9));
    baixas = fundo.map(monta).sort((a, b) => (a.varPct ?? 1e9) - (b.varPct ?? 1e9));
  } else {
    const linhasIbov = tickers.filter((s) => cot[s] && cot[s].varPct !== null).map((s) => pick(s, cot[s]));
    linhasIbov.sort((a, b) => b.varPct - a.varPct);
    altas = linhasIbov.slice(0, 5);
    baixas = linhasIbov.slice(-5).reverse();
    avisos.push('altas e baixas: calculadas so entre acoes do Ibovespa (lista da B3 indisponivel)');
  }

  const tabela2 = await tabelaYahoo(INTL, 'indice');
  const tabela3 = await tabelaYahoo(MOEDAS, 'moeda');

  let graficos = (anterior && anterior.graficosVersao === 2 && anterior.graficos) || {};
  const naHora = agora.getUTCMinutes() < 10;
  for (const [chave, nome, simbolo] of GRAFICOS) {
    if (naHora || !graficos[chave]) {
      const pontos = await seguro('grafico ' + nome, () => graficoYahoo(simbolo), null);
      if (pontos && pontos.length > 1) graficos[chave] = { nome, pontos };
    }
  }

  const dados = {
    atualizadoEm: agora.toISOString(),
    graficosVersao: 2,
    tabela1: { indices, altas, baixas },
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
  console.log('OK. Avisos:', avisos.length, '| acoes na faixa:', tape.length);
  avisos.forEach((a) => console.log(' -', a));
}

principal().catch((e) => {
  console.error('Erro geral:', e.message);
  process.exit(1);
});
