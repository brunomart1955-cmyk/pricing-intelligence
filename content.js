(() => {
  const ROOT_ID = 'shopping-radar-root';
  const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  let products = [];
  let currentSearch = '';
  // Nome(s) da loja para marcar "NOSSO" (configurável pelo admin no painel online).
  const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const regexLoja = nomes => {
    const partes = (nomes || []).map(n => semAcento(n).trim()).filter(Boolean)
      .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
    return partes.length ? new RegExp(partes.join('|'), 'i') : /levanti\s*maquinas/i;
  };
  let lojaRegex = regexLoja();
  let precoPadrao = null;

  // O script também é registrado para /search porque o Google Shopping usa essa
  // rota. Não renderize o painel em resultados comuns do Google.
  function isShoppingPage() {
    return location.pathname.startsWith('/shopping') ||
      new URLSearchParams(location.search).get('tbm') === 'shop' ||
      new URLSearchParams(location.search).get('udm') === '28';
  }

  const parsePrice = (value = '') => {
    const raw = String(value).replace(/^.*?R\$\s*/i, '').match(/[\d.,]+/)?.[0] || '';
    const comma = raw.lastIndexOf(','); const dot = raw.lastIndexOf('.');
    let normalized = raw;
    if (comma >= 0 && dot >= 0) normalized = comma > dot ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
    else if (comma >= 0) normalized = /,\d{1,2}$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
    else if (dot >= 0) normalized = /\.\d{1,2}$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(/\./g, '');
    const price = Number(normalized); return Number.isFinite(price) && price > 0 ? price : null;
  };
  const extractCashPrice = (lines) => {
    const installments = /(?:\b\d{1,2}\s*x\b|parcel(?:a|as|ado)|mensal|por\s+m[eê]s|\/m[eê]s|sem\s+juros)/i;
    const entries = lines.flatMap((line, index) =>
      [...line.matchAll(/R\$\s*[\d.,]+/gi)].map(match => ({
        index,
        line,
        price: parsePrice(match[0])
      }))
    ).filter(entry => Number.isFinite(entry.price) && entry.price > 0 && !installments.test(entry.line));

    // Em promoções pode haver "de R$ X por R$ Y". O menor preço à vista é o
    // valor que o consumidor efetivamente pode pagar, nunca a parcela.
    return entries.reduce((best, entry) => !best || entry.price < best.price ? entry : best, null);
  };
  const parseUserPrice = (value = '') => {
    return parsePrice(value);
  };

  function getSearchTerm() {
    return new URL(location.href).searchParams.get('q') || document.querySelector('input[name="q"]')?.value || '';
  }
  function safeImage(card) {
    const image = card.querySelector('img')?.currentSrc || card.querySelector('img')?.src || '';
    return /^https?:\/\//i.test(image) ? image : '';
  }

  function getOfferUrl(card) {
    // Em alguns layouts o link envolve o card inteiro; em outros ele está dentro.
    // Coletamos ambos e alguns ancestrais para não perder o destino da oferta.
    const anchors = [];
    let scope = card;
    for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
      if (scope.matches?.('a[href]')) anchors.push(scope);
      anchors.push(...scope.querySelectorAll?.('a[href]') || []);
    }
    const isGoogle = url => /(^|\.)google\.[a-z.]+$/i.test(url.hostname);
    const resolveOfferUrl = (url) => {
      if (!isGoogle(url)) return /^https?:$/i.test(url.protocol) ? url.href : '';
      if (!/^\/(url|aclk)/i.test(url.pathname)) return '';

      // "q" é frequentemente apenas o termo pesquisado; usá-lo como URL faz
      // o card voltar para a página de pesquisa do Google. Aceite somente um
      // destino explícito e externo da oferta.
      const target = ['adurl', 'url', 'redirect', 'continue']
        .map(key => url.searchParams.get(key))
        .find(value => /^https?:\/\//i.test(value || ''));
      if (!target) return '';
      try {
        const destination = new URL(target);
        return !isGoogle(destination) && /^https?:$/i.test(destination.protocol) ? destination.href : '';
      } catch {
        return '';
      }
    };

    return anchors
      .map(anchor => new URL(anchor.href, location.origin))
      .filter(url => !/support\.google\.com$/i.test(url.hostname) && !/\/googleshopping\/answer\//i.test(url.pathname))
      .map(resolveOfferUrl)
      .find(Boolean) || '';
  }

  function extractProducts() {
    const seen = new Set();
    const result = [];
    // Estes são os containers usados pelas versões mais comuns do Shopping.
    // O fallback abaixo atende o layout novo, que não deixa preço e link no mesmo elemento.
    const selectors = [
      '.sh-dgr__grid-result', '.sh-dlr__list-result',
      '[data-docid]', '[data-ved][role="listitem"]',
      'div[data-hveid]'
    ];
    const candidates = [...new Set([...document.querySelectorAll(selectors.join(','))])];
    const cards = candidates.filter((card) => {
      const text = card.innerText || '';
      return /R\$\s?[\d.,]+/.test(text) && text.length < 1600;
    });

    cards.forEach((card) => {
      const lines = (card.innerText || '').split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const cashOffer = extractCashPrice(lines);
      if (!cashOffer || cashOffer.index < 1) return;
      const { price, index: priceIndex } = cashOffer;
      // O título fica imediatamente antes do primeiro preço no card do Shopping.
      const name = lines.slice(0, priceIndex).reverse().find(line =>
        line.length > 3 && !/^(novo|usado|frete|oferta|patrocinado)$/i.test(line)
      );
      const store = lines.slice(priceIndex + 1).find(line =>
        line.length > 1 && !/(R\$|frete|parcel|em até|avaliaç|estrela)/i.test(line)
      ) || 'Loja não identificada';
      const fullText = lines.join(' ').toLowerCase();
      const link = getOfferUrl(card);
      const key = `${name}|${price}`;
      if (!name || !price || seen.has(key)) return;
      seen.add(key);
      result.push({
        name: name.slice(0, 120), price, store: store.slice(0, 60), url: link,
        image: safeImage(card),
        promotion: /promoção|oferta do dia|desconto|preço baixo/.test(fullText),
        freeShipping: /frete grátis|entrega grátis|envio grátis/.test(fullText),
        full: /\bfull\b/i.test(fullText),
        international: /internacional|importado|china|exterior|overseas/i.test(fullText),
        ours: lojaRegex.test(semAcento(store))
      });
    });
    // Limite de segurança: evita travamento do navegador ao abrir buscas enormes.
    return result.sort((a, b) => a.price - b.price).slice(0, 100);
  }

  function competitiveLabel(myPrice) {
    const valid = products.map(p => p.price);
    if (!myPrice || !valid.length) return null;
    const lower = valid.filter(p => p < myPrice).length;
    const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
    if (myPrice <= Math.min(...valid)) return { tone: 'best', label: '✓ Seu preço está ganhando!', detail: `${currency.format(Math.min(...valid) - myPrice)} abaixo do menor concorrente` };
    if (myPrice <= avg) return { tone: 'good', label: 'Preço competitivo', detail: `Você ganha de ${valid.length - lower} de ${valid.length} ofertas` };
    return { tone: 'warn', label: 'Preço acima do mercado', detail: `${lower} oferta${lower === 1 ? '' : 's'} custa${lower === 1 ? '' : 'm'} menos · ${((myPrice / avg - 1) * 100).toFixed(0)}% acima da média` };
  }

  function cardComparison(price, myPrice) {
    const minimum = Math.min(...products.map(product => product.price));
    if (myPrice) {
      const percent = Math.abs((price / myPrice - 1) * 100).toFixed(1).replace('.', ',');
      if (price < myPrice) return { tone: 'better', text: `${percent}% abaixo do seu preço` };
      if (price > myPrice) return { tone: 'higher', text: `${percent}% acima do seu preço` };
      return { tone: 'equal', text: 'Mesmo preço que o seu' };
    }
    if (price === minimum) return { tone: 'better', text: 'Menor preço encontrado' };
    const percent = ((price / minimum - 1) * 100).toFixed(1).replace('.', ',');
    return { tone: 'higher', text: `${percent}% acima do menor preço` };
  }

  function persistData(myPrice, myItem) {
    chrome.storage.local.set({ shoppingRadarData: { products, currentSearch, myPrice, myItem, updatedAt: Date.now() } });
  }

  function render() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const term = root.querySelector('#sr-filter')?.value?.toLowerCase() || '';
    const myPrice = parseUserPrice(root.querySelector('#sr-my-price')?.value || '');
    const filtered = products.filter(p => `${p.name} ${p.store}`.toLowerCase().includes(term));
    const stat = competitiveLabel(myPrice);
    root.querySelector('#sr-count').textContent = `${products.length} ofertas encontradas`;
    root.querySelector('#sr-query').textContent = currentSearch || 'Pesquisa atual';
    root.querySelector('#sr-average').textContent = products.length ? currency.format(products.reduce((sum, p) => sum + p.price, 0) / products.length) : '—';
    root.querySelector('#sr-results').innerHTML = filtered.length ? filtered.map(p => {
      const comparison = cardComparison(p.price, myPrice);
      const tag = p.url ? 'a' : 'div';
      const linkAttributes = p.url ? ` href="${p.url}" target="_blank" rel="noopener noreferrer"` : ' aria-disabled="true"';
      return `
      <${tag} class="sr-item ${p.ours ? 'sr-ours' : ''}"${linkAttributes}>
        <span class="sr-item-name">${escapeHtml(p.name)}</span>
        <span class="sr-price">${currency.format(p.price)}</span>
        <span class="sr-store">${escapeHtml(p.store)}</span>
        <span class="sr-badges"><b class="sr-badge comparison ${comparison.tone}">${comparison.text}</b>${p.ours ? '<b class="sr-badge ours">NOSSO</b>' : ''}${p.full ? '<b class="sr-badge full">FULL</b>' : ''}${p.international ? '<b class="sr-badge intl">Internacional</b>' : ''}${p.promotion ? '<b class="sr-badge promo">Promoção</b>' : ''}${p.freeShipping ? '<b class="sr-badge shipping">Frete grátis</b>' : ''}</span>
      </${tag}>`;
    }).join('') : '<div class="sr-empty">Nenhuma oferta encontrada. Role a página e atualize.</div>';
    const box = root.querySelector('#sr-competition');
    if (stat) {
      box.className = `sr-competition ${stat.tone}`;
      box.innerHTML = `<strong>${stat.label}</strong><span>${stat.detail}</span>`;
    } else {
      box.className = 'sr-competition';
      box.innerHTML = '<strong>Compare seu preço</strong><span>Informe um valor para analisar a competitividade.</span>';
    }
    persistData(myPrice, root.querySelector('#sr-my-item')?.value.trim() || '');
  }

  function escapeHtml(text) { const el = document.createElement('span'); el.textContent = text; return el.innerHTML; }

  function refresh() {
    if (!document.getElementById(ROOT_ID)) return;
    const nextSearch = getSearchTerm();
    currentSearch = nextSearch;
    products = extractProducts();
    render();
  }

  function mount() {
    if (document.getElementById(ROOT_ID)) return;
    const root = document.createElement('aside');
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="sr-header"><div><span class="sr-kicker">SHOPPING RADAR</span><h2>Monitor de preços</h2></div><div class="sr-window-actions"><span title="Arraste o canto inferior direito para redimensionar">↘</span><button id="sr-close" title="Fechar painel">×</button></div></div>
      <div class="sr-search"><input id="sr-filter" type="search" placeholder="Filtrar itens ou lojas"></div>
      <div class="sr-price-form"><label>Seu item e seu preço</label><div><input id="sr-my-item" placeholder="Ex.: Carro turbo"><input id="sr-my-price" inputmode="decimal" placeholder="R$ 250,00"></div></div>
      <div id="sr-competition" class="sr-competition"></div>
      <div class="sr-summary"><span id="sr-count"></span><button id="sr-refresh">↻ Atualizar</button><button id="sr-clear">Limpar</button><button id="sr-dashboard">Dashboard</button></div>
      <div class="sr-dashboard-note">Atualize para ler a página atual, limpe para iniciar outra pesquisa.</div>
      <div class="sr-market"><span>Pesquisa: <b id="sr-query"></b></span><span>Média: <b id="sr-average"></b></span></div>
      <div id="sr-results" class="sr-results"></div>`;
    document.documentElement.append(root);
    if (precoPadrao) root.querySelector('#sr-my-price').value = precoPadrao.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    root.querySelector('#sr-close').onclick = () => root.remove();
    root.querySelector('#sr-refresh').onclick = refresh;
    root.querySelector('#sr-clear').onclick = () => { products = []; render(); chrome.storage.local.remove('shoppingRadarData'); };
    root.querySelector('#sr-dashboard').onclick = () => chrome.runtime.sendMessage({ type: 'open-dashboard', page: 'dashboard.html' });
    root.querySelector('#sr-filter').oninput = render;
    root.querySelector('#sr-my-price').oninput = render;
    enableDrag(root, root.querySelector('.sr-header'));
    refresh();
  }

  function enableDrag(panel, handle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('pointerdown', (event) => {
      // Botões do cabeçalho mantêm suas próprias ações.
      if (event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      dragging = true;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      handle.setPointerCapture(event.pointerId);
      panel.classList.add('sr-dragging');
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const rect = panel.getBoundingClientRect();
      const left = Math.max(0, Math.min(window.innerWidth - rect.width, event.clientX - offsetX));
      const top = Math.max(0, Math.min(window.innerHeight - rect.height, event.clientY - offsetY));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    });

    const stopDrag = () => { dragging = false; panel.classList.remove('sr-dragging'); };
    handle.addEventListener('pointerup', stopDrag);
    handle.addEventListener('pointercancel', stopDrag);
  }

  if (!isShoppingPage()) return;

  function iniciar() {
  mount();
  let timer;
  new MutationObserver((records) => {
    // render() altera o próprio painel. Ignorar essas mutações evita um ciclo
    // contínuo de extração, renderização e gravação no chrome.storage.
    const hasExternalChange = records.some((record) => {
      if (!document.getElementById(ROOT_ID)?.contains(record.target)) return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) =>
        node.nodeType !== Node.ELEMENT_NODE || !node.closest?.(`#${ROOT_ID}`)
      );
    });
    if (!hasExternalChange) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 900);
  }).observe(document.body, { childList: true, subtree: true });
  }

  // Configurações do admin (painel online): marketplaces desligados não mostram o radar.
  chrome.storage.local.get('radarConfig', ({ radarConfig = {} }) => {
    const nuvem = radarConfig.nuvem || {};
    const ativos = nuvem.marketplacesAtivos || [];
    if (ativos.length && !ativos.includes('Google Shopping')) return;
    lojaRegex = regexLoja(nuvem.nomesLoja);
    precoPadrao = nuvem.precoPadrao || null;
    iniciar();
  });
})();
