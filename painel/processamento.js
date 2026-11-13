// Processamento dos JSONs exportados pela extensão Shopping Radar.
// Funções puras (sem DOM), usadas pelo painel e pelos testes.
(function (root) {
  'use strict';

  function parsePreco(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
    let s = String(v ?? '').replace(/R\$\s*/i, '').trim();
    if (!s) return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    const n = Number(s.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // "+1000", "1 mil", "5mil vendidos", "2,5 mil", 120 → número (ou null)
  function parseQuantidade(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v ?? '').toLowerCase();
    const m = s.match(/(\d+(?:[.,]\d+)*)\s*(mil|k)?/);
    if (!m) return null;
    let num = m[1];
    if (m[2]) num = num.replace(',', '.');
    else num = num.replace(/[.,]/g, '');
    const n = Number(num) * (m[2] ? 1000 : 1);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  function limparTexto(v) {
    return String(v ?? '').replace(/\s+/g, ' ').trim();
  }

  function oferta(p, marketplace, busca) {
    const preco = parsePreco(p.price ?? p.preco);
    const nome = limparTexto(p.name ?? p.titulo ?? p.nome);
    if (!preco || !nome) return null;
    return {
      name: nome,
      price: preco,
      marketplace: limparTexto(p.source ?? p.marketplace ?? marketplace) || 'Desconhecido',
      seller: limparTexto(p.seller_name || p.seller || p.store || p.loja),
      sales: parseQuantidade(p.product_sales ?? p.vendas),
      reviews: parseQuantidade(p.review_count ?? p.avaliacoes),
      promotion: Boolean(p.promotion ?? p.promocao),
      freeShipping: Boolean(p.freeShipping ?? p.freteGratis),
      full: Boolean(p.full),
      ours: Boolean(p.ours),
      url: /^https?:\/\//i.test(p.url || p.link || '') ? (p.url || p.link) : '',
      search: limparTexto(busca)
    };
  }

  // Aceita: export da extensão (botão "Exportar JSON"), dump do chrome.storage
  // ({shoppingRadarData, marketplaceRadarData}) ou uma lista simples de ofertas.
  function normalizar(dados) {
    if (typeof dados === 'string') dados = JSON.parse(dados);
    if (!dados || typeof dados !== 'object') throw new Error('Arquivo vazio ou inválido.');

    let google = null, mercados = {}, lista = null;
    let exportadoEm = dados.exportadoEm || null;

    if (Array.isArray(dados)) lista = dados;
    else if (Array.isArray(dados.ofertas)) lista = dados.ofertas;
    else {
      google = dados.google ?? dados.shoppingRadarData ?? null;
      mercados = dados.marketplaces ?? dados.marketplaceRadarData ?? {};
    }

    const ofertas = [];
    const datas = [];
    if (lista) {
      lista.forEach(p => { const o = p && oferta(p, '', p.search); if (o) ofertas.push(o); });
    } else {
      if (google && Array.isArray(google.products)) {
        google.products.forEach(p => { const o = oferta(p, 'Google Shopping', google.currentSearch); if (o) { o.marketplace = 'Google Shopping'; ofertas.push(o); } });
        if (google.updatedAt) datas.push(google.updatedAt);
      }
      Object.entries(mercados || {}).forEach(([fonte, bloco]) => {
        if (!bloco || !Array.isArray(bloco.products)) return;
        bloco.products.forEach(p => { const o = oferta(p, fonte, bloco.ownItem); if (o) ofertas.push(o); });
        if (bloco.updatedAt) datas.push(bloco.updatedAt);
      });
    }

    if (!exportadoEm && datas.length) exportadoEm = new Date(Math.max(...datas)).toISOString();
    if (!ofertas.length) throw new Error('Nenhuma oferta encontrada no arquivo. Use o botão "Exportar JSON" da extensão.');
    return { ofertas, exportadoEm: exportadoEm || new Date().toISOString() };
  }

  function media(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null; }

  function resumo(ofertas, meuPreco) {
    const precos = ofertas.map(o => o.price);
    const min = precos.length ? Math.min(...precos) : null;
    const maisBarata = ofertas.find(o => o.price === min);
    return {
      total: ofertas.length,
      canais: new Set(ofertas.map(o => o.marketplace)).size,
      min,
      minCanal: maisBarata ? maisBarata.marketplace : '',
      media: media(precos),
      max: precos.length ? Math.max(...precos) : null,
      abaixo: meuPreco ? ofertas.filter(o => o.price < meuPreco).length : null
    };
  }

  function porMarketplace(ofertas) {
    const grupos = new Map();
    ofertas.forEach(o => { if (!grupos.has(o.marketplace)) grupos.set(o.marketplace, []); grupos.get(o.marketplace).push(o.price); });
    return [...grupos.entries()]
      .map(([nome, precos]) => ({ nome, min: Math.min(...precos), media: media(precos), total: precos.length }))
      .sort((a, b) => a.media - b.media);
  }

  // Uma linha por importação (snapshot), em ordem cronológica.
  function historico(ofertas) {
    const grupos = new Map();
    ofertas.forEach(o => {
      if (!grupos.has(o.snapshotId)) grupos.set(o.snapshotId, { data: o.date, precos: [] });
      grupos.get(o.snapshotId).precos.push(o.price);
    });
    return [...grupos.values()]
      .sort((a, b) => a.data - b.data)
      .map(g => ({ data: g.data, min: Math.min(...g.precos), media: media(g.precos), total: g.precos.length }));
  }

  function vendedores(ofertas, limite = 10) {
    const cont = new Map();
    ofertas.forEach(o => { if (o.seller) cont.set(o.seller, (cont.get(o.seller) || 0) + 1); });
    return [...cont.entries()].map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome)).slice(0, limite);
  }

  function paraCSV(ofertas) {
    const cab = ['Produto', 'Preço', 'Marketplace', 'Vendedor', 'Vendas', 'Avaliações', 'Promoção', 'Frete grátis', 'Importado em', 'Link'];
    const campo = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const linhas = ofertas.map(o => [
      o.name, String(o.price).replace('.', ','), o.marketplace, o.seller, o.sales ?? '', o.reviews ?? '',
      o.promotion ? 'Sim' : 'Não', o.freeShipping ? 'Sim' : 'Não',
      o.date ? new Date(o.date).toLocaleString('pt-BR') : '', o.url
    ].map(campo).join(';'));
    return '﻿' + [cab.map(campo).join(';'), ...linhas].join('\r\n');
  }

  const api = { parsePreco, parseQuantidade, normalizar, resumo, porMarketplace, historico, vendedores, paraCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Processamento = api;
})(typeof window !== 'undefined' ? window : globalThis);
