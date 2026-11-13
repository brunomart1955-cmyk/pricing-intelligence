// Aba "Assistente": chat com o Gemini via Edge Function "assistente" do Supabase.
// O contexto (dados de preços e/ou Magalu) é resumido aqui no navegador e só é
// enviado quando a pessoa marca as opções correspondentes.
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const app = () => window.SRApp;
  const brl = v => (typeof v === 'number' ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—');
  const esc = v => { const e = document.createElement('span'); e.textContent = v ?? ''; return e.innerHTML; };

  const conversa = []; // { papel: 'usuario' | 'assistente', texto }
  let magaluCache = null;
  let enviando = false;

  // Markdown simples: **negrito**, `código`, listas e quebras de linha (sempre escapado antes).
  function formatar(texto) {
    return esc(texto)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>')
      .replace(/^\s*[-*•]\s+(.+)$/gm, '• $1')
      .replace(/\n/g, '<br>');
  }

  function render() {
    const lista = $('#chat-lista');
    lista.innerHTML = conversa.length ? conversa.map(m =>
      `<div class="bolha ${m.papel}">${m.papel === 'assistente' ? formatar(m.texto) : esc(m.texto).replace(/\n/g, '<br>')}</div>`
    ).join('') + (enviando ? '<div class="bolha assistente digitando">Pensando…</div>' : '')
      : `<div class="chat-vazio"><b>Pergunte qualquer coisa sobre preços, concorrentes ou vendas.</b><br>
         Ex.: "Quais concorrentes estão mais baratos que eu?", "Quais SKUs da Magalu estão caindo?", "Sugira um preço para o martelete".</div>`;
    lista.scrollTop = lista.scrollHeight;
    $('#chat-enviar').disabled = enviando;
  }

  function contextoPrecos() {
    const P = app().P;
    const ofertas = app().getOfertas();
    if (!ofertas.length) return 'PREÇOS (Shopping Radar): nenhum dado coletado ainda.';
    const r = P.resumo(ofertas, null);
    const linhas = [
      `PREÇOS (Shopping Radar): ${r.total} ofertas em ${r.canais} canais. Menor ${brl(r.min)} (${r.minCanal}), médio ${brl(r.media)}, maior ${brl(r.max)}.`,
      'Por marketplace (menor / médio / qtd): ' + P.porMarketplace(ofertas).map(m => `${m.nome}: ${brl(m.min)} / ${brl(m.media)} / ${m.total}`).join('; '),
      'Vendedores com mais ofertas: ' + P.vendedores(ofertas, 10).map(v => `${v.nome} (${v.total})`).join(', '),
      'Ofertas mais recentes (produto | preço | canal | vendedor | vendas | nossa?):'
    ];
    const recentes = ofertas.slice().sort((a, b) => b.date - a.date || a.price - b.price).slice(0, 80);
    recentes.forEach(o => linhas.push(`- ${o.name.slice(0, 90)} | ${brl(o.price)} | ${o.marketplace} | ${o.seller || '?'} | ${o.sales ?? '?'} | ${o.ours ? 'NOSSA' : ''}`));
    return linhas.join('\n');
  }

  async function contextoMagalu() {
    if (!magaluCache) {
      const { data, error } = await app().sb.storage.from('magalu').download('dashboard_data.json');
      if (error || !data) return 'VENDAS MAGALU: dados ainda não enviados pelo administrador.';
      magaluCache = JSON.parse(await data.text());
    }
    const o = magaluCache.overview || {};
    const skus = Array.isArray(magaluCache.skus) ? magaluCache.skus : [];
    const var30 = s => (s.prev_30d_sales ? ((s.last_30d_sales / s.prev_30d_sales - 1) * 100).toFixed(0) + '%' : 'novo');
    const linha = s => `- ${s.sku} | ${String(s.name || '').slice(0, 70)} | 30d: ${brl(s.last_30d_sales)} (${s.last_30d_qty} un) | anterior: ${brl(s.prev_30d_sales)} | var ${var30(s)}`;
    const ativos = skus.filter(s => s.last_30d_sales > 0 || s.prev_30d_sales > 0);
    const top = ativos.slice().sort((a, b) => b.last_30d_sales - a.last_30d_sales).slice(0, 40);
    const quedas = ativos.filter(s => s.prev_30d_sales > 0).sort((a, b) => (a.last_30d_sales - a.prev_30d_sales) - (b.last_30d_sales - b.prev_30d_sales)).slice(0, 15);
    const altas = ativos.slice().sort((a, b) => (b.last_30d_sales - b.prev_30d_sales) - (a.last_30d_sales - a.prev_30d_sales)).slice(0, 15);
    const resumoObj = v => JSON.stringify(v ?? {}).slice(0, 1500);
    return [
      `VENDAS MAGALU (Sales Intelligence): dados até ${o.data_through || '?'}, ${o.sku_count || skus.length} SKUs.`,
      `Faturamento últimos 30 dias: ${brl(o.company_last30_sales)}; 30 dias anteriores: ${brl(o.company_prev30_sales)}.`,
      `Totais por loja/canal: ${resumoObj(o.store_totals)}`,
      `Dias da semana mais fortes: ${resumoObj(o.weekday_top)}`,
      `Estoque: ${resumoObj(o.stock_info)}`,
      'Top 40 SKUs por faturamento nos últimos 30 dias (sku | nome | 30d | anterior | variação):', ...top.map(linha),
      'Maiores QUEDAS em R$ vs. período anterior:', ...quedas.map(linha),
      'Maiores ALTAS em R$ vs. período anterior:', ...altas.map(linha)
    ].join('\n');
  }

  async function enviar(e) {
    e?.preventDefault();
    const campo = $('#chat-texto');
    const texto = campo.value.trim();
    if (!texto || enviando) return;
    conversa.push({ papel: 'usuario', texto });
    campo.value = '';
    enviando = true; render();
    try {
      const partes = [];
      if ($('#ctx-precos').checked) partes.push(contextoPrecos());
      if ($('#ctx-magalu').checked) partes.push(await contextoMagalu());
      const { data, error } = await app().sb.functions.invoke('assistente', {
        // Mensagens de erro ficam só na tela; não vão como histórico para o Gemini.
        body: { mensagens: conversa.filter(m => !m.erro), contexto: partes.join('\n\n') }
      });
      let erro = data?.erro;
      if (error) {
        try { erro = (await error.context.json()).erro; } catch { erro = /Failed to send|fetch/i.test(error.message)
          ? 'O assistente ainda não foi instalado no Supabase (Edge Function "assistente").' : error.message; }
      }
      conversa.push(erro ? { papel: 'assistente', texto: `⚠️ ${erro}`, erro: true } : { papel: 'assistente', texto: data.texto });
    } catch (err) {
      conversa.push({ papel: 'assistente', texto: `⚠️ ${err.message}`, erro: true });
    } finally {
      enviando = false; render();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('#chat-form')) return;
    $('#chat-form').addEventListener('submit', enviar);
    $('#chat-texto').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) enviar(e); });
    $('#chat-limpar').addEventListener('click', () => { conversa.length = 0; render(); });
    render();
  });
})();
