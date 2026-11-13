(() => {
  const ROOT = 'marketplace-radar-root';
  const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

  const parsePrice = value => {
    const raw = String(value || '').replace(/^.*?R\$\s*/i, '').match(/[\d.,]+/)?.[0] || '';
    const comma = raw.lastIndexOf(','), dot = raw.lastIndexOf('.');
    let normalized = raw;
    if (comma >= 0 && dot >= 0) normalized = comma > dot ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
    else if (comma >= 0) normalized = /,\d{1,2}$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
    else if (dot >= 0) normalized = /\.\d{1,2}$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(/\./g, '');
    const n = Number(normalized);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const parseOwnPrice = value => parsePrice(value);
  // Nome(s) da loja para marcar "NOSSO" (configurável pelo admin no painel online).
  const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const regexLoja = nomes => {
    const partes = (nomes || []).map(n => semAcento(n).trim()).filter(Boolean)
      .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
    return partes.length ? new RegExp(partes.join('|'), 'i') : /levanti\s*maquinas/i;
  };
  let lojaRegex = regexLoja();
  let precoPadrao = null;
  const source = location.hostname.includes('mercadolivre') ? 'Mercado Livre'
    : location.hostname.includes('magazineluiza') ? 'Magalu'
    : location.hostname.includes('shopee') ? 'Shopee'
    : location.hostname.includes('aliexpress') ? 'AliExpress'
    : location.hostname.includes('shopcoopera') ? 'Shop Coopera'
    : location.hostname.includes('amazon') ? 'Amazon' : 'Amazon';

  let products = [];
  let observations = {};
  let detailsRunning = false;
  let lastDetailsSignature = '';

  // Uma vez lida, a ficha de um anúncio não precisa ser aberta de novo por
  // muito tempo. Sem esse controle, qualquer produto cujo dado nunca aparece
  // (ex.: vendedor sem "há X anos" visível) fica pendente pra sempre e a fila
  // reabre aba atrás de aba a cada atualização — foi esse o loop relatado.
  const DETAIL_STALE_MS = 24 * 60 * 60 * 1000; // 24h até tentar reler
  // Quando a leitura roda mas NENHUM dado é encontrado (vendedor, vendas,
  // tempo, avaliações — tudo vazio), é mais provável que a aba não teve
  // tempo de terminar do que o anúncio realmente não ter essa informação.
  // Por isso um resultado totalmente vazio tenta de novo bem mais cedo, em
  // vez de ficar "checado" por 24h com o card preso em "não visível".
  const DETAIL_RETRY_EMPTY_MS = 45 * 60 * 1000; // 45min
  // A pedido do lojista, voltou a ficar mais rápido (as abas de uma leva
  // agora abrem em paralelo, em pool, no background.js, então uma leva
  // maior não demora tanto quanto antes). Ainda evitamos abrir tudo de uma
  // vez só — ver DETAIL_CONCURRENCY em background.js.
  const DETAIL_BATCH_LIMIT = 8; // no máx. essa quantidade de abas por leva
  // Faixa aleatória em vez de um número fixo: um intervalo sempre idêntico
  // entre levas é, por si só, um padrão fácil de identificar como automação.
  // Reduzida pra ficar perto de 3-4s entre uma leva e a próxima, como pedido.
  const BETWEEN_BATCHES_DELAY_RANGE = [3000, 4500];

  function isChecked(url) {
    const obs = observations[productKey(url)];
    if (!obs?.checkedAt) return false;
    const staleMs = obs.emptyResult ? DETAIL_RETRY_EMPTY_MS : DETAIL_STALE_MS;
    return Date.now() - obs.checkedAt < staleMs;
  }

  const safeImage = card => {
    const image = card.querySelector('img')?.currentSrc || card.querySelector('img')?.src || '';
    return /^https?:\/\//i.test(image) ? image : '';
  };

  const config = {
    'Mercado Livre': {
      cards: 'li.ui-search-layout__item',
      title: '.poly-component__title',
      price: '.andes-money-amount__fraction',
      link: 'a.poly-component__title'
    },
    'Amazon': {
      cards: '[data-component-type="s-search-result"]',
      title: 'h2 span',
      price: '.a-price .a-offscreen',
      link: 'h2 a'
    },
    'Shopee': {
      cards: '[data-sqe="item"], div.shopee-search-item-result__item',
      title: '[data-sqe="name"], .line-clamp-2',
      price: '.truncate, .text-shopee-primary',
      link: 'a'
    },
    'Magalu': {
      cards: '[data-testid="product-card-container"], [data-testid="product-card-content"]',
      title: '[data-testid="product-title"], h2, h3',
      price: '[data-testid="price-value"], [data-testid="price"]',
      link: 'a'
    },
    // AliExpress e Shop Coopera não têm uma seletor de classe estável e
    // documentado como os demais (AliExpress ofusca as classes e muda com
    // frequência; Shop Coopera é uma loja VTEX cujo tema pode variar). Por
    // isso o "card" já é o próprio link do produto, e título/preço usam um
    // texto genérico com respaldo em regex — ver titleFor() e o fallback de
    // preço em extract().
    'AliExpress': {
      cards: 'a[href*="/item/"]',
      title: '',
      price: '',
      link: ''
    },
    'Shop Coopera': {
      cards: 'a[href$="/p"], a[href*="/p?"], a[href*="/p#"]',
      title: '',
      price: '',
      link: ''
    }
  };

  function text(el, selector) {
    if (!selector) return '';
    return el.querySelector(selector)?.textContent?.trim() || '';
  }

  // Alguns marketplaces (AliExpress, Shop Coopera) não expõem o título do
  // produto num seletor confiável de texto — cai pro alt da imagem ou algum
  // atributo de acessibilidade antes de desistir do card.
  function titleFor(card, rule) {
    const direct = text(card, rule.title);
    if (direct) return direct;
    const imgAlt = card.querySelector('img[alt]')?.getAttribute('alt')?.trim();
    if (imgAlt) return imgAlt;
    const ariaLabel = card.getAttribute('aria-label')?.trim()
      || card.querySelector('[aria-label]')?.getAttribute('aria-label')?.trim();
    if (ariaLabel) return ariaLabel;
    return card.getAttribute('title')?.trim() || '';
  }

  function extractMercadoLivreItemId(url = '') {
    try {
      const normalized = decodeURIComponent(url);
      const match = normalized.match(/(?:^|[/?#&_-])(MLB-?\d{6,})(?:[/?#&_-]|$)/i);
      return match ? match[1].replace('-', '').toUpperCase() : '';
    } catch {
      return '';
    }
  }

  function productKey(url = location.href) {
    const itemId = extractMercadoLivreItemId(url);
    if (itemId) return `ml:${itemId}`;
    try {
      const parsed = new URL(url, location.origin);
      return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '').toLowerCase();
    } catch { return ''; }
  }

  function normalizeCount(value = '') {
    const match = String(value).replace(/\s+/g, ' ').match(/(\+?\s*\d+(?:[.,]\d+)?\s*(?:mil|k)?)/i);
    return match ? match[1].replace(/\s+/g, '') : '';
  }

  function findSellerBox(doc = document) {
    // A caixa de reputação do vendedor concentra "vendas" e "há X anos" perto
    // do nome da loja. Isolar esse texto evita confundir vendas do vendedor
    // com vendas do próprio anúncio, que aparecem perto do título/preço.
    const candidates = [
      '.ui-pdp-seller__header', '.ui-pdp-seller',
      '[class*="seller" i]', '[data-testid*="seller" i]'
    ];
    for (const selector of candidates) {
      const el = doc.querySelector(selector);
      if (el && /vend/i.test(el.textContent || '')) return el;
    }
    return null;
  }

  function extractProductSales(pageText) {
    // No Mercado Livre esse número normalmente aparece logo abaixo do título,
    // no formato "Novo | +500 vendidos" — é a venda do anúncio, não da loja.
    const match = pageText.match(/\+?\s*\d[\d.,]*\s*(?:mil\s*)?\s*vendidos?\b/i);
    return match ? normalizeCount(match[0]) : '';
  }

  function extractSellerSales(scopeText) {
    const match = scopeText.match(/\+?\s*\d[\d.,]*\s*(?:mil\s*)?\s*vendas?\b/i);
    return match ? normalizeCount(match[0]) : '';
  }

  function extractSellerTenure(scopeText) {
    // Texto típico da reputação: "Há mais de 5 anos vendendo no Mercado Livre".
    const match = scopeText.match(/h[áa]\s+(mais\s+de\s+)?\d+\s+(dia|dias|semana|semanas|m[êe]s|meses|ano|anos)\b[^.\n]{0,25}/i);
    return match ? match[0].replace(/\s+/g, ' ').trim() : '';
  }

  function reviewScopeElements(doc = document) {
    return [...doc.querySelectorAll('[class*="review" i], [data-testid*="review" i], [id*="review" i]')];
  }

  function findFirstReviewDate(doc = document, { preferTopmost = false } = {}) {
    const scopes = reviewScopeElements(doc);
    const units = { dia: 1, dias: 1, semana: 7, semanas: 7, mês: 30, meses: 30, ano: 365, anos: 365 };

    if (preferTopmost) {
      // Depois de ordenar a lista por "mais antigas", a primeira opinião com
      // uma data já É a mais antiga — não precisamos comparar nada, só ler a
      // primeira que aparecer na ordem do DOM.
      for (const scope of scopes) {
        const text = scope.innerText || scope.textContent || '';
        const absolute = text.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
        if (absolute) {
          const date = new Date(Number(absolute[3]), Number(absolute[2]) - 1, Number(absolute[1]));
          if (!Number.isNaN(date.getTime()) && date <= new Date()) return date.toLocaleDateString('pt-BR');
        }
        const relative = text.match(/\bhá\s+(\d+)\s+(dia|dias|semana|semanas|mês|meses|ano|anos)\b/i);
        if (relative) return relative[0].replace(/\s+/g, ' ').trim();
      }
    }

    const content = (scopes.length ? scopes : [doc.body]).map(el => el.innerText || el.textContent || '').join('\n');
    const dates = [...content.matchAll(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/g)]
      .map(match => new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])))
      .filter(date => !Number.isNaN(date.getTime()) && date <= new Date());
    if (dates.length) return new Date(Math.min(...dates.map(date => date.getTime()))).toLocaleDateString('pt-BR');

    // No Mercado Livre a data da opinião pode aparecer como "Há 8 meses".
    // Entre todas as opiniões carregadas, a de maior intervalo é a mais antiga.
    const relativeDates = [...content.matchAll(/\bhá\s+(\d+)\s+(dia|dias|semana|semanas|mês|meses|ano|anos)\b/gi)]
      .map(match => ({ label: match[0], days: Number(match[1]) * units[match[2].toLowerCase()] }))
      .filter(entry => Number.isFinite(entry.days));
    return relativeDates.sort((a, b) => b.days - a.days)[0]?.label || '';
  }

  function readVisibleProductData(doc = document) {
    const pageText = (doc.body?.innerText || doc.body?.textContent || '').replace(/\u00a0/g, ' ');
    const ratingMatch = pageText.match(/\b(\d{1,3}(?:[.\s]\d{3})*)\s+avaliações\b/i);
    const sellerSelectors = [
      // Layout atual da ficha do produto: nome da loja fica sozinho dentro desse H3.
      'h3.text-on-surface-2',
      '.ui-pdp-seller__header__title', '.ui-pdp-seller__header__title a',
      '[class*="seller" i] [class*="title" i]', '[data-testid*="seller" i] [class*="title" i]',
      '[class*="seller" i] a', '[class*="store" i] a', '[data-testid*="seller" i] a'
    ];
    const seller = sellerSelectors.map(selector => doc.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() || '')
      .find(value => value && value.length < 80 && !/^(loja oficial|vendedor|mercado livre)$/i.test(value)) || '';

    // "Vendidos" perto do título é do anúncio; "vendas" e "há X anos" dentro da
    // caixa do vendedor são da loja. Separar as duas evita números trocados.
    const sellerBox = findSellerBox(doc);
    const sellerBoxText = sellerBox?.innerText || sellerBox?.textContent || '';
    const productSales = extractProductSales(pageText);
    const sellerSales = extractSellerSales(sellerBoxText) || extractSellerSales(pageText);
    const sellerTenure = extractSellerTenure(sellerBoxText) || extractSellerTenure(pageText);

    return {
      seller_name: seller || null,
      review_count: ratingMatch?.[1]?.replace(/\s/g, '') || null,
      first_review_date: findFirstReviewDate(doc, { preferTopmost: reviewsSortedOldest }) || null,
      product_sales: productSales || null,
      seller_sales: sellerSales || null,
      seller_time: sellerTenure || null,
      reviewPageUrl: findReviewPageLink() || null,
      observedAt: Date.now()
    };
  }

  // "Mostrar todas as opiniões" é o texto real do link no layout atual do
  // Mercado Livre — o código só reconhecia "ver todas", por isso esse link
  // quase nunca era seguido e a avaliação mais antiga ficava sem achar.
  const REVIEW_LINK_PATTERN = /(?:ver|mostrar)\s+todas?\s*(?:as\s*)?(?:opiniões|avaliações)/i;

  function findReviewPageLink() {
    // Esse link costuma abrir uma página dedicada (/review/...) ou uma mini
    // sessão com o histórico completo de opiniões — é lá que dá pra achar a
    // avaliação mais antiga, não na ficha do produto.
    const anchors = [...document.querySelectorAll('a[href]')];
    const dedicated = anchors.find(anchor =>
      /\/review\//i.test(anchor.getAttribute('href') || '') && REVIEW_LINK_PATTERN.test(anchor.textContent || ''));
    if (dedicated) return dedicated.href;
    const fallback = anchors.find(anchor =>
      REVIEW_LINK_PATTERN.test(anchor.textContent || '') || /mais opiniões|mais avaliações/i.test(anchor.textContent || ''));
    return fallback?.href || '';
  }

  function isProductPage() {
    return source !== 'Mercado Livre' || /MLB-?\d{6,}/i.test(location.href);
  }

  function captureVisibleProductData() {
    if (!isProductPage()) return;
    const key = productKey();
    if (!key) return;
    const { reviewPageUrl, ...data } = readVisibleProductData();
    observations[key] = { ...observations[key], ...data, checkedAt: Date.now() };
    chrome.storage.local.set({ marketplaceRadarObservations: observations });
  }

  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  // Sorteia um valor dentro de uma faixa em vez de usar sempre o mesmo tempo
  // fixo — ações de automação com timing idêntico toda vez são um dos sinais
  // que marketplaces usam pra distinguir bot de gente navegando.
  const jitter = ([min, max]) => Math.round(min + Math.random() * (max - min));

  // Setada por revealReviewData() e lida por readVisibleProductData(): diz se
  // conseguimos reordenar a lista de opiniões pela mais antiga primeiro.
  let reviewsSortedOldest = false;

  // Espera o conteúdo da página parar de crescer, em vez de um tempo fixo —
  // páginas de anúncio variam muito de velocidade, principalmente em abas de
  // segundo plano, e um tempo fixo curto demais é a causa mais provável de
  // "às vezes retorna os dados, às vezes não".
  async function waitForContentToSettle(maxWaitMs = 6000, checkEveryMs = 400) {
    let previousLength = -1;
    let stableRounds = 0;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const length = (document.body?.innerText || '').length;
      if (length === previousLength) {
        stableRounds += 1;
        if (stableRounds >= 2) return;
      } else {
        stableRounds = 0;
      }
      previousLength = length;
      await wait(checkEveryMs);
    }
  }

  async function trySortReviewsOldestFirst() {
    // Custa mais caro que os outros passos (abre menu, espera reordenar),
    // então cada chamada individual fica sob orçamento curto — ver os
    // valores de espera abaixo e o timeout maior em background.js.
    // O seletor "Ordenar" da área de opiniões costuma abrir uma lista com
    // opções como "Mais relevantes", "Mais recentes", etc. Procuramos por um
    // gatilho chamado "Ordenar" e, dentro do menu que ele abre, por uma opção
    // que indique ordem cronológica crescente (mais antigas primeiro).
    const trigger = [...document.querySelectorAll('button, [role="button"], [role="combobox"], summary')]
      .find(element => /^ordenar\b|^ordenar por\b/i.test((element.textContent || '').trim()));
    if (!trigger) return false;

    trigger.click();
    await wait(jitter([200, 450]));

    const options = [...document.querySelectorAll('[role="option"], [role="menuitem"], li, button, a')];
    const option = options.find(element =>
      /mais\s+antig|menos\s+recentes?|antigas?\s+primeiro|data\s*\(?\s*crescente/i.test(element.textContent || ''));

    if (!option) {
      // Fecha o menu sem escolher nada pra não deixar a página num estado estranho.
      document.body.click();
      return false;
    }

    option.click();
    await wait(jitter([400, 800]));
    await waitForContentToSettle(2000);
    return true;
  }

  async function revealReviewData() {
    reviewsSortedOldest = false;
    const reviewSection = document.querySelector('[class*="review" i], [data-testid*="review" i], [id*="review" i]');
    reviewSection?.scrollIntoView({ block: 'center', behavior: 'instant' });
    await wait(jitter([300, 600]));
    // "Mostrar todas as opiniões" normalmente é um link que abre uma mini
    // sessão/modal dentro da mesma página (é uma SPA — não navega pra outro
    // lugar), então clicamos nele direto em vez de abrir uma segunda aba só
    // pra isso. Aceita botão ou link porque o Mercado Livre usa os dois
    // conforme o layout do anúncio.
    const reviewButton = [...document.querySelectorAll('button, [role="button"], a')]
      .find(element => REVIEW_LINK_PATTERN.test(element.textContent || '') ||
        /mais opiniões|mais avaliações/i.test(element.textContent || ''));
    if (reviewButton) {
      reviewButton.click();
      await waitForContentToSettle(2500);
    }

    // Tenta reordenar por mais antigas ANTES de carregar mais páginas: assim,
    // cada "carregar mais" clicado a seguir continua trazendo opiniões nessa
    // mesma ordem (da mais antiga pra frente), em vez da ordem padrão.
    reviewsSortedOldest = await trySortReviewsOldestFirst();

    // Quando não há como ordenar, carregamos o máximo de opiniões possível e
    // comparamos todas as datas encontradas pra achar a mais antiga.
    const maxClicks = reviewsSortedOldest ? 3 : 6;
    for (let clicks = 0; clicks < maxClicks; clicks += 1) {
      // Uma pequena pausa antes de cada clique, como se estivesse lendo a
      // página antes de agir, em vez de clicar imediatamente toda vez.
      await wait(jitter([150, 400]));
      const loadMoreButton = [...document.querySelectorAll('button, [role="button"]')]
        .find(element => /carregar mais|mostrar mais|ver mais avaliações|ver mais opiniões|próxima página/i.test(element.textContent || ''));
      if (loadMoreButton) {
        loadMoreButton.click();
      } else {
        // Alguns layouts carregam mais opiniões por rolagem (scroll infinito)
        // em vez de um botão — simula isso antes de desistir.
        window.scrollBy(0, window.innerHeight * 2);
      }
      await waitForContentToSettle(1500);
      if (reviewsSortedOldest && findFirstReviewDate(document, { preferTopmost: true })) break;
    }
  }

  function setProgress(completed, total) {
    const note = document.querySelector('#mr-api-note');
    if (note) note.textContent = `Lendo detalhes dos anúncios: ${completed}/${total}`;
    chrome.storage.local.set({ marketplaceRadarProgress: { source, completed, total, updatedAt: Date.now() } });
  }

  function clearProgress() {
    chrome.storage.local.remove('marketplaceRadarProgress');
  }

  // No modo sem abas o background devolve o HTML do anúncio ({ html }); aqui
  // ele vira um documento e passa pelos mesmos leitores da página aberta.
  // No modo "Leitura completa" os dados já chegam prontos da aba.
  function dadosDoAnuncio(resposta) {
    if (!resposta) return {};
    if (typeof resposta.html !== 'string') return resposta;
    try {
      const doc = new DOMParser().parseFromString(resposta.html, 'text/html');
      return readVisibleProductData(doc);
    } catch (_) {
      return {};
    }
  }

  async function enrichCardsFromPages() {
    const unchecked = products.filter(product => product.url && !isChecked(product.url));
    const pending = unchecked.slice(0, DETAIL_BATCH_LIMIT);
    const signature = pending.map(product => productKey(product.url)).join('|');
    if (!pending.length || detailsRunning || signature === lastDetailsSignature) return;

    detailsRunning = true;
    lastDetailsSignature = signature;
    const note = document.querySelector('#mr-api-note');
    const total = pending.length;
    let completed = 0;
    setProgress(0, total);
    try {
      const response = await chrome.runtime.sendMessage({ type: 'read-product-pages', products: pending });
      for (const product of pending) {
        const { reviewPageUrl, ...data } = dadosDoAnuncio(response?.data?.[product.url]);
        const key = productKey(product.url);
        // Se nenhum campo veio preenchido, é mais provável que a aba não
        // teve tempo de terminar do que o anúncio realmente não ter nada —
        // marca como "resultado vazio" pra essa releitura acontecer bem
        // mais cedo (ver DETAIL_RETRY_EMPTY_MS), em vez de ficar 24h preso
        // em "não visível".
        const emptyResult = !data.seller_name && !data.product_sales && !data.seller_time
          && !data.review_count && !data.first_review_date;
        if (key) observations[key] = { ...observations[key], ...data, checkedAt: Date.now(), emptyResult };
        completed += 1;
        setProgress(completed, total);
      }
    } catch (_) {
      // Mesmo com erro, marca a leva como verificada agora — evita que uma
      // falha de rede vire um loop de tentativas infinitas. Como "vazio",
      // pra tentar de novo mais cedo em vez de esperar 24h.
      pending.forEach(product => {
        const key = productKey(product.url);
        if (key) observations[key] = { ...observations[key], checkedAt: Date.now(), emptyResult: true };
      });
      if (note) note.textContent = 'Não foi possível ler os detalhes dos anúncios.';
    }
    await chrome.storage.local.set({ marketplaceRadarObservations: observations });
    detailsRunning = false;
    clearProgress();
    refresh(false);

    // Ainda há produtos não verificados além desta leva: continua sozinho, em
    // lotes pequenos, sem esperar uma nova mutação no DOM pra retomar. A
    // pausa entre levas é aleatória e propositalmente mais longa — é a troca
    // de velocidade por menos risco de bloqueio pedida pelo lojista.
    const stillPending = products.some(product => product.url && !isChecked(product.url));
    if (stillPending) setTimeout(() => void enrichCardsFromPages(), jitter(BETWEEN_BATCHES_DELAY_RANGE));
  }

  function extract() {
    const rule = config[source];
    const seen = new Set();

    return [...document.querySelectorAll(rule.cards)].map(card => {
      const title = titleFor(card, rule);
      const price = parsePrice(text(card, rule.price) || card.innerText.match(/R\$\s?[\d.,]+/)?.[0]);
      const anchor = source === 'Amazon'
        ? card.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]') || card.querySelector(rule.link)
        // AliExpress e Shop Coopera: o "card" selecionado já é o próprio <a>
        // do produto (não há um contêiner separado confiável em volta dele).
        : (source === 'AliExpress' || source === 'Shop Coopera')
          ? (card.matches('a[href]') ? card : card.closest('a[href]') || card.querySelector('a[href]'))
          : card.querySelector(rule.link);
      const url = anchor?.href || '';
      const all = card.innerText.toLowerCase();
      const key = `${title}|${price}|${url}`;

      if (!title || !price || seen.has(key)) return null;
      seen.add(key);

      const seller = source === 'Mercado Livre'
        ? text(card, '.poly-component__seller')
        : source === 'Amazon'
          ? (text(card, '.a-row.a-size-base.a-color-secondary') || 'Amazon')
          : source; // Shopee, Magalu, AliExpress e Shop Coopera não mostram o vendedor na lista de busca

      const itemId = source === 'Mercado Livre' ? extractMercadoLivreItemId(url) : '';

      const observation = observations[productKey(url)] || {};
      return {
        name: title.slice(0, 150),
        price,
        url,
        source,
        seller: seller.slice(0, 70),
        seller_name: observation.seller_name || null,
        seller_id: null,
        item_id: itemId || null,
        review_count: observation.review_count || null,
        first_review_date: observation.first_review_date || null,
        product_sales: observation.product_sales || null,
        seller_sales: observation.seller_sales || null,
        seller_time: observation.seller_time || null,
        checked: !!observation.checkedAt,
        available_quantity: null,
        permalink: null,
        image: safeImage(card),
        promotion: /promoção|oferta|desconto/.test(all),
        freeShipping: /frete grátis|frete gratis|entrega grátis/.test(all),
        full: /\bfull\b/.test(all),
        international: /internacional|importado|china|exterior|overseas/.test(all),
        ours: lojaRegex.test(semAcento(`${title} ${seller}`))
      };
    }).filter(Boolean).slice(0, 100);
  }

  function score(price, own) {
    if (!own) return '';
    const pct = Math.abs((price / own - 1) * 100).toFixed(1).replace('.', ',');
    return price < own ? `${pct}% abaixo do seu preço`
      : price > own ? `${pct}% acima do seu preço`
      : 'Mesmo preço';
  }

  function mergeProducts(previous, current) {
    // Uma página que não é lista de busca (ex.: a ficha de um produto) extrai
    // zero cards. Sem esse merge, salvar aquele resultado vazio apagava as
    // ofertas já coletadas em buscas anteriores — era por isso que o
    // dashboard ficava zerado depois de abrir um anúncio específico.
    const byKey = new Map();
    previous.forEach(product => byKey.set(`${product.name}|${product.price}|${product.url}`, product));
    current.forEach(product => byKey.set(`${product.name}|${product.price}|${product.url}`, product));
    return [...byKey.values()].slice(-300);
  }

  function save(ownPrice, ownItem) {
    chrome.storage.local.get('marketplaceRadarData', ({ marketplaceRadarData = {} }) => {
      const previous = marketplaceRadarData[source]?.products || [];
      marketplaceRadarData[source] = {
        products: products.length ? mergeProducts(previous, products) : previous,
        ownPrice,
        ownItem,
        source,
        updatedAt: Date.now()
      };
      chrome.storage.local.set({ marketplaceRadarData });
    });
  }

  function render() {
    const root = document.getElementById(ROOT);
    if (!root) return;

    const own = parseOwnPrice(root.querySelector('#mr-price').value);
    const item = root.querySelector('#mr-item').value.trim();
    const term = root.querySelector('#mr-filter').value.toLowerCase();

    root.querySelector('#mr-count').textContent = `${products.length} ofertas em ${source}`;
    root.querySelector('#mr-status').textContent = own && products.length
      ? (own <= Math.min(...products.map(p => p.price))
        ? '✓ Seu preço está no menor nível encontrado'
        : `Há ${products.filter(p => p.price < own).length} ofertas abaixo do seu preço`)
      : 'Informe seu preço para comparar';

    root.querySelector('#mr-results').innerHTML = products
      .filter(p => `${p.name} ${p.source} ${p.seller} ${p.seller_name || ''}`.toLowerCase().includes(term))
      .map(p => {
        const sellerName = p.seller_name || p.seller || '';
        const salesLine = p.product_sales ? `${p.product_sales} vendidos` : '';
        const sellerLine = sellerName
          ? `<small class="mr-seller"><b>Vendido por</b> ${escapeHtml(sellerName)}${salesLine ? ` · ${escapeHtml(salesLine)}` : ''}</small>`
          : '';
        return `<a class="mr-card ${p.ours ? 'mr-ours' : ''}" href="${p.url}" target="_blank" rel="noopener noreferrer">
          <b>${escapeHtml(p.name)}</b>
          <strong>${money.format(p.price)}</strong>
          ${sellerLine}
          <small>${escapeHtml(score(p.price, own))}</small>
          <span>${p.ours ? 'NOSSO · ' : ''}${p.full ? 'FULL · ' : ''}${p.promotion ? 'Promoção · ' : ''}${p.freeShipping ? 'Frete grátis' : ''}</span>
        </a>`;
      }).join('') || '<p>Nenhuma oferta localizada. Role a página e atualize.</p>';

    save(own, item);
  }

  function escapeHtml(value) {
    const el = document.createElement('span');
    el.textContent = value ?? '';
    return el.innerHTML;
  }

  function refresh(loadDetails = true) {
    products = extract();
    render();
    if (loadDetails) void enrichCardsFromPages();
  }

  function mount() {
    if (document.getElementById(ROOT)) return;

    const root = document.createElement('aside');
    root.id = ROOT;
    root.innerHTML = `<header><span>MARKETPLACE RADAR · ${source}</span><button id="mr-close">×</button></header>
      <input id="mr-filter" class="mr-filter" placeholder="Pesquisar produto, loja ou concorrente">
      <input id="mr-item" placeholder="Seu item">
      <input id="mr-price" placeholder="Seu preço (R$)">
      <div id="mr-status"></div>
      <div class="mr-line"><b id="mr-count"></b><button id="mr-refresh">↻ Atualizar</button><button id="mr-clear">Limpar</button><button id="mr-dashboard">Dashboard</button></div>
      <div id="mr-api-note">Lendo as páginas dos anúncios para completar avaliações, primeira avaliação e vendas.</div>
      <div id="mr-results"></div>`;

    document.documentElement.append(root);
    if (precoPadrao) root.querySelector('#mr-price').value = precoPadrao.toLocaleString('pt-BR', { minimumFractionDigits: 2 });

    root.querySelector('#mr-close').onclick = () => root.remove();
    root.querySelector('#mr-refresh').onclick = refresh;
    root.querySelector('#mr-clear').onclick = () => {
      products = [];
      render();
      chrome.storage.local.get('marketplaceRadarData', data => {
        const all = data.marketplaceRadarData || {};
        delete all[source];
        chrome.storage.local.set({ marketplaceRadarData: all });
      });
    };
    root.querySelector('#mr-dashboard').onclick = () =>
      chrome.runtime.sendMessage({
        type: 'open-dashboard',
        page: `marketplaces.html?source=${encodeURIComponent(source)}`
      });

    root.querySelector('#mr-price').oninput = render;
    root.querySelector('#mr-item').oninput = render;
    root.querySelector('#mr-filter').oninput = render;

    enableDrag(root, root.querySelector('header'));
    refresh();
  }

  function enableDrag(panel, handle) {
    let active = false, offsetX = 0, offsetY = 0;

    handle.addEventListener('pointerdown', event => {
      if (event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      active = true;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener('pointermove', event => {
      if (!active) return;
      const rect = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(0, Math.min(innerWidth - rect.width, event.clientX - offsetX))}px`;
      panel.style.top = `${Math.max(0, Math.min(innerHeight - rect.height, event.clientY - offsetY))}px`;
    });

    handle.addEventListener('pointerup', () => { active = false; });
    handle.addEventListener('pointercancel', () => { active = false; });
  }

  function iniciar() {
  mount();
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'product-page-progress') {
      const note = document.querySelector('#mr-api-note');
      if (note) note.textContent = `Lendo detalhes dos anúncios: ${message.completed}/${message.total}`;
      return;
    }
    if (message?.type !== 'read-product-page-data') return;
    void (async () => {
      await revealReviewData();
      sendResponse(readVisibleProductData());
    })();
    return true;
  });
  chrome.storage.local.get('marketplaceRadarObservations', ({ marketplaceRadarObservations = {} }) => {
    observations = marketplaceRadarObservations;
    captureVisibleProductData();
    refresh();
  });

  let timer;
  new MutationObserver(records => {
    const panel = document.getElementById(ROOT);
    if (panel && records.every(record => panel.contains(record.target))) return;
    clearTimeout(timer);
    timer = setTimeout(() => { captureVisibleProductData(); refresh(); }, 1300);
  }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // Configurações do admin (painel online): marketplaces desligados não mostram o radar.
  chrome.storage.local.get('radarConfig', ({ radarConfig = {} }) => {
    const nuvem = radarConfig.nuvem || {};
    const ativos = nuvem.marketplacesAtivos || [];
    if (ativos.length && !ativos.includes(source)) return;
    lojaRegex = regexLoja(nuvem.nomesLoja);
    precoPadrao = nuvem.precoPadrao || null;
    iniciar();
  });
})();
