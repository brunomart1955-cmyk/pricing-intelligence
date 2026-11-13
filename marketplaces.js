const money = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const safe = text => { const el=document.createElement('span'); el.textContent=text ?? ''; return el.innerHTML; };
const parsePrice = value => { const n=Number(String(value||'').trim().replace(/^R\$\s*/i,'').replace(/\./g,'').replace(',','.')); return Number.isFinite(n)&&n>0?n:null; };
const validOfferUrl = value => { try { const url=new URL(value); return !/support\.google\.com$/i.test(url.hostname)&&!/\/googleshopping\/answer\//i.test(url.pathname); } catch { return false; } };
const sellerText = product => product.seller_name || product.seller || 'Anunciante não identificado';

// Uma aba por marketplace suportado, mais "Todos" pra ver tudo junto.
const SOURCES = ['Mercado Livre','Magalu','Shopee','Amazon','AliExpress','Shop Coopera'];

let marketplaceData={}; let settings={};
let activeTab = new URLSearchParams(location.search).get('source') || 'Todos';
if (!SOURCES.includes(activeTab)) activeTab = 'Todos';

function productsForTab(tab){
  if (tab === 'Todos') return Object.values(marketplaceData).flatMap(group=>group.products||[]);
  return marketplaceData[tab]?.products || [];
}

function renderTabs(){
  const wrap = document.querySelector('#tabs');
  const tabs = ['Todos', ...SOURCES];
  wrap.innerHTML = tabs.map(tab => {
    const count = productsForTab(tab).length;
    return `<button class="tab ${tab===activeTab?'active':''}" data-tab="${safe(tab)}">${safe(tab)}<b>${count}</b></button>`;
  }).join('');
  wrap.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    render();
  }));
}

function render(){
  renderTabs();
  const all = productsForTab(activeTab);
  const term=document.querySelector('#filter').value.trim().toLowerCase();
  const ownPrice=parsePrice(document.querySelector('#own-price').value);
  const onlyPromo=document.querySelector('#only-promo').checked, onlyShipping=document.querySelector('#only-shipping').checked, showImages=document.querySelector('#show-images').checked, showUnavailable=document.querySelector('#show-unavailable').checked;

  const visible=all
    .filter(product=>`${product.name} ${product.source} ${product.seller||''} ${product.seller_name||''}`.toLowerCase().includes(term)&&(!onlyPromo||product.promotion)&&(!onlyShipping||product.freeShipping)&&(showUnavailable||validOfferUrl(product.url)))
    .sort((a,b)=>a.price-b.price);
  lastVisible = visible;

  const prices=all.map(product=>product.price).filter(Number.isFinite);
  const minimum=prices.length?Math.min(...prices):null;
  const average=prices.length?prices.reduce((a,b)=>a+b,0)/prices.length:null;

  document.querySelector('#total').textContent=all.length;
  document.querySelector('#minimum').textContent=minimum?money.format(minimum):'—';
  document.querySelector('#average').textContent=average?money.format(average):'—';
  document.querySelector('#my-price').textContent=ownPrice?money.format(ownPrice):'Não informado';
  document.querySelector('#results-title').textContent = activeTab==='Todos' ? 'Ofertas' : `Ofertas em ${activeTab}`;

  if (activeTab==='Todos') {
    const updatedCount = Object.keys(marketplaceData).length;
    document.querySelector('#updated').textContent = updatedCount?`${updatedCount} marketplace(s) atualizado(s)`:'';
  } else {
    const updatedAt = marketplaceData[activeTab]?.updatedAt;
    document.querySelector('#updated').textContent = updatedAt?`Atualizado às ${new Date(updatedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`:'Ainda sem dados salvos nesta aba';
  }
  renderProgress();

  document.querySelector('#results').innerHTML=visible.length?visible.map(product=>{
    const pct=ownPrice?Math.abs((product.price/ownPrice-1)*100).toFixed(1).replace('.',','):((product.price/minimum-1)*100).toFixed(1).replace('.',',');
    const below=ownPrice&&product.price<ownPrice;
    const comparison=ownPrice?`${pct}% ${below?'abaixo':product.price>ownPrice?'acima':'igual ao'} do seu preço`:product.price===minimum?'Menor preço encontrado':`${pct}% acima do menor preço`;
    const tag=validOfferUrl(product.url)?'a':'div';
    const href=validOfferUrl(product.url)?` href="${product.url}" target="_blank" rel="noopener noreferrer"`:'';
    const image=showImages&&product.image?`<img class="product-image" src="${safe(product.image)}" alt="">`:'';
    const seller=sellerText(product);
    // Se o anúncio ainda não foi verificado em segundo plano, um campo vazio
    // provavelmente só está esperando a leitura terminar — não é "sem dado".
    const checked=!!product.checked;
    const pending='Carregando informações, recarregue a página.';
    const tenureRaw=product.seller_time
      ? product.seller_time.replace(/^h[áa]\s*/i,'')
      : (product.first_review_date?`desde ${product.first_review_date} (estimado pela 1ª avaliação)`:null);
    const tenureLine=tenureRaw?`Tempo mínimo do anúncio: ${tenureRaw}`:(checked?'Tempo do anúncio não encontrado':pending);
    const salesLine=product.product_sales?`${product.product_sales} vendidos neste anúncio`:(checked?'Vendas do anúncio não visíveis':pending);
    const reviewsLine=product.review_count?`${product.review_count} avaliações`:(checked?'Avaliações não visíveis':pending);
    const sourceBadge = activeTab==='Todos' ? `<span class="source-badge">${safe(product.source)}</span>` : '';
    const details=`<span class="seller-line"><b>Vendido por</b> ${safe(seller)}</span><span>${safe(salesLine)}</span><span>${safe(tenureLine)}</span><span>${safe(reviewsLine)}</span>`;

    return `<${tag} class="card"${href}>${image}<h3>${sourceBadge}${safe(product.name)}</h3><strong>${money.format(product.price)}</strong><div class="meta">${details}</div><div class="badges"><b class="comparison ${below?'better':'higher'}">${comparison}</b>${product.promotion?'<b class="promo">Promoção</b>':''}${product.freeShipping?'<b class="shipping">Frete grátis</b>':''}${validOfferUrl(product.url)?'':'<b class="unavailable">Link indisponível</b>'}</div></${tag}>`;
  }).join(''):`<div class="empty">${all.length?'Nenhuma oferta corresponde aos filtros.':'Abra uma busca em um marketplace suportado, ou use "Buscar em todos" acima, e atualize o painel.'}</div>`;
}

let lastVisible = [];
let progressInfo=null;
let searchInfo=null;

function renderProgress(){
  const wrap=document.querySelector('#progress-wrap');
  if(!wrap) return;
  // A leitura fica "parada" se a aba de origem foi fechada no meio do
  // processo; depois de 20s sem atualização, tratamos como concluída.
  const stale=progressInfo && Date.now()-progressInfo.updatedAt>20000;
  if(!progressInfo || stale || progressInfo.completed>=progressInfo.total){
    wrap.hidden=true;
    return;
  }
  wrap.hidden=false;
  const pct=Math.round((progressInfo.completed/Math.max(1,progressInfo.total))*100);
  document.querySelector('#progress-bar').style.width=`${pct}%`;
  document.querySelector('#progress-label').textContent=`Lendo detalhes em ${progressInfo.source}: ${progressInfo.completed}/${progressInfo.total}`;
}

function saveSettings(){
  settings={myItem:document.querySelector('#my-item').value.trim(),ownPrice:parsePrice(document.querySelector('#own-price').value)};
  chrome.storage.local.set({marketplaceDashboardSettings:settings});
  render();
}

function loadFromStorage(){
  chrome.storage.local.get(['marketplaceRadarData','marketplaceDashboardSettings','marketplaceRadarProgress'],values=>{
    marketplaceData=values.marketplaceRadarData||{};
    settings=values.marketplaceDashboardSettings||{};
    progressInfo=values.marketplaceRadarProgress||null;
    document.querySelector('#my-item').value=settings.myItem||'';
    document.querySelector('#own-price').value=settings.ownPrice||'';
    render();
  });
}

loadFromStorage();

// Reavalia a barra periodicamente mesmo sem mudança de storage, pra aplicar
// a regra de "parado há mais de 20s" e escondê-la sozinha quando preciso.
setInterval(renderProgress, 4000);

['filter','only-promo','only-shipping','show-images','show-unavailable'].forEach(id=>document.querySelector(`#${id}`).addEventListener(id==='filter'?'input':'change',render));
document.querySelector('#my-item').addEventListener('change',saveSettings);
document.querySelector('#own-price').addEventListener('change',saveSettings);

// Atualizar: relê o armazenamento do zero, útil quando uma leitura em
// segundo plano terminou e o painel ainda não recebeu o evento de mudança.
document.querySelector('#reload-btn').addEventListener('click', loadFromStorage);

// Limpar: some só com os dados da aba atual (ou de tudo, em "Todos", com
// confirmação, já que apaga várias lojas de uma vez).
document.querySelector('#clear-btn').addEventListener('click', () => {
  if (activeTab==='Todos') {
    if (!confirm('Isso limpa os dados salvos de TODOS os marketplaces. Continuar?')) return;
    marketplaceData = {};
  } else {
    if (!marketplaceData[activeTab]) { render(); return; }
    delete marketplaceData[activeTab];
  }
  chrome.storage.local.set({marketplaceRadarData: marketplaceData});
  render();
});

// Exportar CSV: exporta exatamente a lista visível (já filtrada) da aba atual.
document.querySelector('#export-csv-btn').addEventListener('click', () => {
  if (!lastVisible.length) return;
  const header = ['Marketplace','Produto','Preço','Vendedor','Vendas do anúncio','Tempo mínimo do anúncio','Avaliações','Promoção','Frete grátis','Link'];
  const csvField = value => `"${String(value ?? '').replace(/"/g,'""')}"`;
  const rows = lastVisible.map(product => [
    product.source,
    product.name,
    product.price,
    sellerText(product),
    product.product_sales || '',
    product.seller_time || product.first_review_date || '',
    product.review_count || '',
    product.promotion ? 'Sim' : 'Não',
    product.freeShipping ? 'Sim' : 'Não',
    product.url
  ].map(csvField).join(','));
  const csv = '﻿' + [header.map(csvField).join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0,10);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `shopping-radar-${activeTab.toLowerCase().replace(/\s+/g,'-')}-${stamp}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// Buscar em todos os marketplaces (ou só no marketplace da aba atual) sem
// precisar navegar manualmente: o background abre a busca de cada site em
// segundo plano, um de cada vez, com pausas — o content script de cada
// marketplace já extrai e salva os cards sozinho ao carregar a página.
const searchBtn = document.querySelector('#search-all-btn');
const searchStatus = document.querySelector('#search-status');

searchBtn.addEventListener('click', () => {
  const query = document.querySelector('#search-query').value.trim();
  if (!query) return;
  const sources = activeTab==='Todos' ? SOURCES : [activeTab];
  searchBtn.disabled = true;
  searchBtn.textContent = '🔎 Buscando…';
  searchStatus.textContent = `Preparando busca em ${sources.length} marketplace(s)…`;
  chrome.runtime.sendMessage({type:'search-marketplaces', query, sources}, () => {
    searchBtn.disabled = false;
    searchBtn.textContent = '🔎 Buscar em todos';
    searchStatus.textContent = 'Busca concluída. Os cards aparecem conforme cada marketplace responde.';
    loadFromStorage();
    setTimeout(() => { if (searchStatus.textContent.startsWith('Busca concluída')) searchStatus.textContent=''; }, 6000);
  });
});

chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local')return;
  if(changes.marketplaceRadarData){
    marketplaceData=changes.marketplaceRadarData.newValue||{};
    render();
  }
  if(changes.marketplaceRadarProgress){
    progressInfo=changes.marketplaceRadarProgress.newValue||null;
    renderProgress();
  }
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'marketplace-search-progress') {
    searchStatus.textContent = `Buscando em ${message.source}… (${message.completed}/${message.total})`;
  }
});

// Exportar JSON: gera um arquivo com TODOS os dados coletados (Google Shopping
// + marketplaces) no formato aceito pelo painel web (shopping-radar-painel).
document.querySelector('#export-json-btn').addEventListener('click', () => {
  chrome.storage.local.get(['shoppingRadarData','marketplaceRadarData'], values => {
    const payload = {
      app: 'shopping-radar',
      formato: 1,
      versao: chrome.runtime.getManifest().version,
      exportadoEm: new Date().toISOString(),
      google: values.shoppingRadarData || null,
      marketplaces: values.marketplaceRadarData || {}
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0,16).replace(/[:T]/g,'-');
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `shopping-radar-${stamp}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
});


// Modo de leitura dos anúncios: sem abas (padrão) ou completa (janela minimizada).
(() => {
  const box = document.querySelector('#leitura-completa');
  if (!box) return;
  chrome.storage.local.get('radarConfig', ({ radarConfig = {} }) => { box.checked = Boolean(radarConfig.leituraCompleta); });
  box.addEventListener('change', () => {
    chrome.storage.local.get('radarConfig', ({ radarConfig = {} }) => {
      chrome.storage.local.set({ radarConfig: { ...radarConfig, leituraCompleta: box.checked } });
    });
  });
})();
