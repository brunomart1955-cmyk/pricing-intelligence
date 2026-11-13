importScripts('nuvem.js'); // login + sincronização com o painel online

// Ler a avaliação mais antiga (tentando ordenar a lista e carregar mais
// páginas de opiniões) demora mais que uma leitura simples da ficha do
// produto. 15s era curto demais e cortava a leitura no meio, o que também
// contribuía pra abas parecendo travadas/recarregando. Foi aumentado de
// novo (28s -> 32s) porque abas em segundo plano concorrendo entre si
// (mesmo em paralelo limitado) ficam mais lentas pra executar o JS da
// página — o Chrome dá menos prioridade a abas inativas.
const PAGE_READY_TIMEOUT = 32000;

// Um tempo de espera fixo, igual sempre, é em si um padrão fácil de
// reconhecer como automação, então continuamos usando uma faixa aleatória em
// vez de um número único.
const PAGE_RENDER_DELAY_RANGE = [1800, 3000];

// Quantas abas de anúncio ficam abertas AO MESMO TEMPO. Tentamos sem limite
// (abrir a leva inteira de uma vez) e os dados voltaram vazios — vários
// anúncios do mesmo marketplace competindo pelo mesmo processo do Chrome
// atrapalham a leitura (o clique em "Ordenar" e a espera das opiniões
// carregarem não tinham tempo de terminar). Um "pool" pequeno é o meio
// termo: bem mais rápido que uma aba de cada vez, sem sobrecarregar.
const DETAIL_CONCURRENCY = 3;
const SEARCH_CONCURRENCY = 4; // domínios diferentes, então aguenta mais abas juntas

const FETCH_CONCURRENCY = 3; // downloads de página simultâneos (modo sem abas)
const FETCH_TIMEOUT = 20000;
const PAGINA_BLOQUEIO = /suspicious-traffic|account-verification|negative_traffic|validateCaptcha|Robot Check/i;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- Leitura sem abas ----------
// Baixa o HTML do anúncio e devolve só o necessário para o content script
// interpretar com os mesmos leitores (readVisibleProductData). Scripts,
// estilos e SVGs saem para a mensagem ficar leve; o espaço entre tags evita
// que textos de elementos vizinhos grudem ("4.8+500 vendidos").
async function baixarPagina(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    await wait(jitter([200, 700]));
    const resp = await fetch(url, { credentials: 'include', signal: ctrl.signal, headers: { Accept: 'text/html' } });
    if (!resp.ok) return null;
    let html = await resp.text();
    html = html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
      .replace(/></g, '> <');
    // Página de verificação anti-robô do marketplace (testada sem os scripts,
    // para não confundir com um reCAPTCHA embutido numa página normal).
    if (PAGINA_BLOQUEIO.test(html)) return { bloqueado: true };
    return { html: html.slice(0, 2_000_000), finalUrl: resp.url };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Janela minimizada para as abas ----------
// Quando abas são realmente necessárias ("Leitura completa" e "Buscar em
// todos"), elas abrem numa janela minimizada própria, sem bagunçar a janela
// em que a pessoa está trabalhando. A janela fecha sozinha quando a fila acaba.
let janelaOculta = null; // Promise<windowId>
let abasOcultasAtivas = 0;
let fecharJanelaTimer = null;

chrome.windows.onRemoved.addListener(id => {
  if (janelaOculta) janelaOculta.then(w => { if (w === id) janelaOculta = null; }).catch(() => {});
});

async function criarAbaOculta(url) {
  clearTimeout(fecharJanelaTimer);
  abasOcultasAtivas += 1;
  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    try {
      if (!janelaOculta) {
        janelaOculta = chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false }).then(w => w.id);
      }
      const windowId = await janelaOculta;
      return await chrome.tabs.create({ windowId, url, active: false });
    } catch (_) {
      janelaOculta = null; // janela fechada pelo usuário: cria outra
    }
  }
  return chrome.tabs.create({ url, active: false });
}

function liberarAbaOculta() {
  abasOcultasAtivas = Math.max(0, abasOcultasAtivas - 1);
  if (abasOcultasAtivas) return;
  clearTimeout(fecharJanelaTimer);
  fecharJanelaTimer = setTimeout(async () => {
    if (abasOcultasAtivas || !janelaOculta) return;
    try { await chrome.windows.remove(await janelaOculta); } catch (_) { /* já fechada */ }
    janelaOculta = null;
  }, 4000);
}
const jitter = ([min, max]) => Math.round(min + Math.random() * (max - min));

// Processa "items" com no máximo "concurrency" workers rodando ao mesmo
// tempo: assim que um termina, o próximo da fila começa — bem mais rápido
// que um de cada vez, mas sem abrir dezenas de abas simultâneas.
function runPool(items, worker, concurrency) {
  return new Promise(resolve => {
    if (!items.length) { resolve([]); return; }
    const results = new Array(items.length);
    let nextIndex = 0;
    let activeCount = 0;
    let finishedCount = 0;
    const startNext = async () => {
      if (nextIndex >= items.length) return;
      const index = nextIndex++;
      activeCount += 1;
      // Mesmo dentro do pool, as primeiras abas não abrem todas no
      // exatíssimo mesmo instante.
      if (index > 0 && index < concurrency) await wait(jitter([250, 600]));
      try {
        results[index] = await worker(items[index], index);
      } catch (_) {
        results[index] = null;
      }
      activeCount -= 1;
      finishedCount += 1;
      if (finishedCount >= items.length) { resolve(results); return; }
      void startNext();
    };
    const starters = Math.min(concurrency, items.length);
    for (let i = 0; i < starters; i += 1) void startNext();
  });
}

function openPageAndRead(url) {
  return new Promise(async resolve => {
    let tabId = null;
    let settled = false;
    const finish = async value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (tabId) {
        try { await chrome.tabs.remove(tabId); } catch (_) { /* tab já fechada */ }
      }
      liberarAbaOculta();
      resolve(value || null);
    };
    const onUpdated = async (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      // O DOM do anúncio, sobretudo avaliações, pode ser preenchido após o load.
      setTimeout(async () => {
        try {
          const data = await chrome.tabs.sendMessage(tabId, { type: 'read-product-page-data' });
          await finish(data);
        } catch (_) {
          await finish(null);
        }
      }, jitter(PAGE_RENDER_DELAY_RANGE));
    };
    const timeout = setTimeout(() => void finish(null), PAGE_READY_TIMEOUT);
    chrome.tabs.onUpdated.addListener(onUpdated);
    try {
      const tab = await criarAbaOculta(url);
      tabId = tab.id;
      // O tempo-limite pode ter vencido enquanto a aba era criada.
      if (settled) chrome.tabs.remove(tabId).catch(() => {});
    } catch (_) {
      await finish(null);
    }
  });
}

// URLs de busca por marketplace, usadas pela busca disparada direto do
// dashboard ("Buscar em todos"). Cada site monta a URL de pesquisa do seu
// próprio jeito.
function buildSearchUrl(source, query) {
  const q = encodeURIComponent(query);
  switch (source) {
    case 'Mercado Livre': return `https://lista.mercadolivre.com.br/${q}`;
    case 'Magalu': return `https://www.magazineluiza.com.br/busca/${q}/`;
    case 'Shopee': return `https://shopee.com.br/search?keyword=${q}`;
    case 'Amazon': return `https://www.amazon.com.br/s?k=${q}`;
    case 'AliExpress': return `https://pt.aliexpress.com/wholesale?SearchText=${q}`;
    case 'Shop Coopera': return `https://www.shopcoopera.com.br/${q}?map=ft`;
    default: return null;
  }
}

// Tempo de espera depois da página de busca terminar de carregar, antes de
// fechar a aba — dá tempo do content script (marketplace.js) extrair os
// cards e salvá-los sozinho no armazenamento; não precisamos pedir os dados
// de volta, ele já faz isso ao simplesmente abrir a página.
const SEARCH_SETTLE_DELAY_RANGE = [2500, 4000];
const SEARCH_TAB_TIMEOUT = 22000;

function openSearchTab(url) {
  return new Promise(async resolve => {
    let tabId = null;
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (tabId) {
        try { await chrome.tabs.remove(tabId); } catch (_) { /* tab já fechada */ }
      }
      liberarAbaOculta();
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      setTimeout(() => void finish(), jitter(SEARCH_SETTLE_DELAY_RANGE));
    };
    const timeout = setTimeout(() => void finish(), SEARCH_TAB_TIMEOUT);
    chrome.tabs.onUpdated.addListener(onUpdated);
    try {
      const tab = await criarAbaOculta(url);
      tabId = tab.id;
      // O tempo-limite pode ter vencido enquanto a aba era criada.
      if (settled) chrome.tabs.remove(tabId).catch(() => {});
    } catch (_) {
      await finish();
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'open-dashboard') {
    chrome.tabs.create({ url: chrome.runtime.getURL(message.page || 'dashboard.html') });
    return;
  }

  if (message?.type === 'search-marketplaces') {
    const query = String(message.query || '').trim();
    const sources = Array.isArray(message.sources) && message.sources.length
      ? message.sources
      : ['Mercado Livre', 'Magalu', 'Shopee', 'Amazon', 'AliExpress', 'Shop Coopera'];
    if (!query) {
      sendResponse({ ok: false, error: 'Busca vazia' });
      return;
    }
    (async () => {
      let completed = 0;
      const notify = source => {
        completed += 1;
        if (sender.tab?.id) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'marketplace-search-progress', completed, total: sources.length, source
          }).catch(() => {});
        }
      };
      // Cada marketplace é um site diferente, então abrimos as buscas em
      // paralelo (até SEARCH_CONCURRENCY de cada vez) em vez de esperar uma
      // terminar pra começar a próxima.
      await runPool(sources, async source => {
        const url = buildSearchUrl(source, query);
        if (url) await openSearchTab(url);
        notify(source);
      }, SEARCH_CONCURRENCY);
      sendResponse({ ok: true });
    })().catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== 'read-product-pages') return;
  const entries = (message.products || [])
    .filter(product => /^https?:\/\//i.test(product?.url || ''))
    .slice(0, 100);

  (async () => {
    const data = {};
    let completed = 0;
    // Padrão: baixa o HTML de cada anúncio em segundo plano, SEM abrir abas.
    // "Leitura completa" (opção no dashboard) volta a abrir os anúncios, mas
    // numa janela minimizada separada — necessário só para dados que a página
    // monta via JavaScript (ex.: Shopee, data da avaliação mais antiga).
    const { radarConfig = {} } = await chrome.storage.local.get('radarConfig');
    const completa = Boolean(radarConfig.leituraCompleta);
    await runPool(entries, async product => {
      let pageData = completa ? await openPageAndRead(product.url) : await baixarPagina(product.url);
      // Download bloqueado pelo marketplace: lê esse anúncio pela janela minimizada.
      if (pageData?.bloqueado) pageData = await openPageAndRead(product.url);
      if (pageData) data[product.url] = pageData;
      completed += 1;
      if (sender.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, { type: 'product-page-progress', completed, total: entries.length }).catch(() => {});
      }
    }, completa ? DETAIL_CONCURRENCY : FETCH_CONCURRENCY);
    sendResponse({ ok: true, data, modo: completa ? 'completa' : 'rapida' });
  })().catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});
