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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
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
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
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
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      setTimeout(() => void finish(), jitter(SEARCH_SETTLE_DELAY_RANGE));
    };
    const timeout = setTimeout(() => void finish(), SEARCH_TAB_TIMEOUT);
    chrome.tabs.onUpdated.addListener(onUpdated);
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
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
    // Até DETAIL_CONCURRENCY abas abertas ao mesmo tempo — rápido, mas sem
    // deixar várias abas do mesmo marketplace competindo entre si a ponto de
    // a leitura de opiniões não ter tempo de terminar (foi o que causou os
    // cards voltando com "não visível" em tudo).
    await runPool(entries, async product => {
      const pageData = await openPageAndRead(product.url);
      if (pageData) data[product.url] = pageData;
      completed += 1;
      if (sender.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, { type: 'product-page-progress', completed, total: entries.length }).catch(() => {});
      }
    }, DETAIL_CONCURRENCY);
    sendResponse({ ok: true, data });
  })().catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});
