(function () {
  'use strict';
  const P = window.Processamento;
  const $ = s => document.querySelector(s);
  const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const num = new Intl.NumberFormat('pt-BR');
  const fmtData = ms => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  const esc = v => { const e = document.createElement('span'); e.textContent = v ?? ''; return e.innerHTML; };

  const cfg = window.SR_CONFIG || {};
  const temSupabase = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  const sb = temSupabase ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  let store = null;          // { listar, adicionar, remover }
  let snapshots = [];        // registros salvos
  let ofertas = [];          // ofertas processadas de todos os snapshots
  let ordem = { campo: 'price', asc: true };
  let visiveis = [];
  const graficos = {};

  // ---------- Telas ----------
  function mostrar(tela) {
    ['setup', 'auth', 'app'].forEach(t => { $(`#view-${t}`).hidden = t !== tela; });
  }
  function msg(el, texto, tipo) { el.textContent = texto || ''; el.className = `msg ${tipo || ''}`; }

  // ---------- Armazenamento ----------
  const storeSupabase = {
    async listar() {
      const { data, error } = await sb.from('snapshots')
        .select('id, nome, exportado_em, criado_em, total_ofertas, dados')
        .order('exportado_em', { ascending: true });
      if (error) throw error;
      return data;
    },
    async adicionar(reg) {
      const { data, error } = await sb.from('snapshots').insert(reg)
        .select('id, nome, exportado_em, criado_em, total_ofertas, dados').single();
      if (error) throw error;
      return data;
    },
    async remover(id) {
      const { error } = await sb.from('snapshots').delete().eq('id', id);
      if (error) throw error;
    }
  };

  function storeDemo() {
    const mem = gerarExemplo().map((dados, i) => ({
      id: `demo-${i}`, nome: `Exemplo ${i + 1}`, exportado_em: dados.exportadoEm,
      total_ofertas: P.normalizar(dados).ofertas.length, dados
    }));
    let seq = mem.length;
    return {
      async listar() { return mem.slice(); },
      async adicionar(reg) { const r = { ...reg, id: `demo-${seq++}` }; mem.push(r); return r; },
      async remover(id) { const i = mem.findIndex(r => r.id === id); if (i >= 0) mem.splice(i, 1); }
    };
  }

  // Dados fictícios para o modo demonstração (lojas e produtos inventados).
  function gerarExemplo() {
    const canais = ['Mercado Livre', 'Magalu', 'Amazon', 'Shopee', 'Google Shopping'];
    const lojas = ['Loja Alfa', 'Ferramentas Beta', 'Casa Gama', 'Depósito Delta', 'Oficina Ômega', 'Mega Épsilon'];
    const produtos = [['Martelete 800W SDS Plus', 820], ['Furadeira de Impacto 650W', 260], ['Esmerilhadeira 4 1/2" 850W', 310], ['Parafusadeira 12V 2 Baterias', 450]];
    const agora = Date.now();
    return [21, 14, 7, 0].map((diasAtras, s) => {
      const marketplaces = {};
      let rnd = 7 + s * 13;
      const r = () => (rnd = (rnd * 9301 + 49297) % 233280) / 233280;
      canais.filter(c => c !== 'Google Shopping').forEach(canal => {
        marketplaces[canal] = {
          source: canal, updatedAt: agora - diasAtras * 864e5,
          products: produtos.flatMap(([nome, base]) => [0, 1].map(() => ({
            name: nome, price: Math.round(base * (0.88 + r() * 0.3) * (1 - s * 0.015) * 100) / 100,
            seller_name: lojas[Math.floor(r() * lojas.length)], product_sales: `+${Math.floor(r() * 50) * 10} vendidos`,
            promotion: r() > 0.7, freeShipping: r() > 0.4, url: ''
          })))
        };
      });
      return { app: 'shopping-radar', formato: 1, exportadoEm: new Date(agora - diasAtras * 864e5).toISOString(), google: null, marketplaces };
    });
  }

  // ---------- Dados ----------
  function reconstruirOfertas() {
    ofertas = [];
    snapshots.forEach(s => {
      try {
        const { ofertas: lista } = P.normalizar(s.dados);
        const data = new Date(s.exportado_em || s.criado_em).getTime();
        lista.forEach(o => ofertas.push({ ...o, snapshotId: s.id, snapshotNome: s.nome, date: data }));
      } catch (e) { console.warn('Snapshot ignorado', s.id, e); }
    });
  }

  async function carregar() {
    msg($('#app-msg'), 'Carregando…');
    try {
      snapshots = await store.listar();
      reconstruirOfertas();
      preencherFiltros();
      render();
      msg($('#app-msg'), snapshots.length ? '' : 'Nenhuma importação ainda. Exporte o JSON na extensão e arraste aqui.');
    } catch (e) {
      msg($('#app-msg'), `Erro ao carregar: ${e.message}`, 'error');
    }
  }

  async function importarArquivos(files) {
    const lista = [...files];
    if (!lista.length) return;
    let ok = 0; const erros = [];
    for (const f of lista) {
      try {
        if (f.size > 15 * 1024 * 1024) throw new Error('arquivo maior que 15 MB');
        const dados = JSON.parse(await f.text());
        const { ofertas: of, exportadoEm } = P.normalizar(dados);
        if (snapshots.some(s => s.exportado_em && new Date(s.exportado_em).getTime() === new Date(exportadoEm).getTime() && s.total_ofertas === of.length)) {
          throw new Error('já importado antes');
        }
        const reg = await store.adicionar({ nome: f.name.replace(/\.json$/i, ''), exportado_em: exportadoEm, total_ofertas: of.length, dados });
        snapshots.push(reg); ok++;
      } catch (e) { erros.push(`${f.name}: ${e.message}`); }
    }
    snapshots.sort((a, b) => new Date(a.exportado_em) - new Date(b.exportado_em));
    reconstruirOfertas(); preencherFiltros(); render();
    msg($('#app-msg'), [ok ? `${ok} arquivo(s) importado(s).` : '', ...erros].filter(Boolean).join(' · '), erros.length ? 'error' : 'ok');
  }

  // ---------- Filtros ----------
  function preencherFiltros() {
    const mSel = $('#f-market'), sSel = $('#f-snapshot');
    const mAtual = mSel.value, sAtual = sSel.value;
    const canais = [...new Set(ofertas.map(o => o.marketplace))].sort();
    mSel.innerHTML = '<option value="">Todos</option>' + canais.map(c => `<option>${esc(c)}</option>`).join('');
    sSel.innerHTML = '<option value="">Todas</option>' + snapshots.slice().reverse()
      .map(s => `<option value="${esc(s.id)}">${esc(fmtData(new Date(s.exportado_em || s.criado_em)))} · ${esc(s.nome || '')}</option>`).join('');
    if (canais.includes(mAtual)) mSel.value = mAtual;
    if (snapshots.some(s => String(s.id) === sAtual)) sSel.value = sAtual;
  }

  function meuPreco() { return P.parsePreco($('#f-own').value); }

  function filtrar({ ignorarSnapshot = false } = {}) {
    const termo = $('#f-text').value.trim().toLowerCase();
    const canal = $('#f-market').value;
    const snap = $('#f-snapshot').value;
    return ofertas.filter(o =>
      (!termo || `${o.name} ${o.seller} ${o.search}`.toLowerCase().includes(termo)) &&
      (!canal || o.marketplace === canal) &&
      (ignorarSnapshot || !snap || String(o.snapshotId) === snap));
  }

  // ---------- Render ----------
  function cor(nome) { return getComputedStyle(document.documentElement).getPropertyValue(nome).trim(); }

  function grafico(id, config) {
    if (graficos[id]) graficos[id].destroy();
    graficos[id] = new Chart($(id), config);
  }

  function opcoesBase() {
    const texto = cor('--muted'), grade = cor('--border');
    return {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: texto, boxWidth: 12 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${money.format(c.parsed.y ?? c.parsed.x)}` } }
      },
      scales: {
        x: { ticks: { color: texto }, grid: { color: grade } },
        y: { ticks: { color: texto, callback: v => money.format(v) }, grid: { color: grade } }
      }
    };
  }

  function render() {
    visiveis = filtrar();
    const own = meuPreco();
    const r = P.resumo(visiveis, own);

    $('#k-total').textContent = num.format(r.total);
    $('#k-total-sub').textContent = r.total ? `${r.canais} canal(is)` : '';
    $('#k-min').textContent = r.min ? money.format(r.min) : '—';
    $('#k-min-sub').textContent = r.minCanal;
    $('#k-avg').textContent = r.media ? money.format(r.media) : '—';
    $('#k-avg-sub').textContent = r.max ? `máx. ${money.format(r.max)}` : '';
    $('#k-below').textContent = own ? num.format(r.abaixo) : '—';
    $('#k-below-sub').textContent = own ? `de ${num.format(r.total)} ofertas` : 'informe seu preço';

    const c1 = cor('--series-1'), c2 = cor('--series-2');

    const pm = P.porMarketplace(visiveis);
    const ownLine = own ? [{ type: 'line', label: 'Seu preço', data: pm.map(() => own), borderColor: cor('--danger'), borderDash: [6, 4], pointRadius: 0, borderWidth: 2 }] : [];
    grafico('#c-market', {
      type: 'bar',
      data: { labels: pm.map(m => m.nome), datasets: [
        { label: 'Menor', data: pm.map(m => m.min), backgroundColor: c1, borderRadius: 4 },
        { label: 'Médio', data: pm.map(m => m.media), backgroundColor: c2, borderRadius: 4 },
        ...ownLine
      ] },
      options: opcoesBase()
    });

    const h = P.historico(filtrar({ ignorarSnapshot: true }));
    grafico('#c-history', {
      type: 'line',
      data: { labels: h.map(p => fmtData(p.data).slice(0, 8)), datasets: [
        { label: 'Menor', data: h.map(p => p.min), borderColor: c1, backgroundColor: c1, tension: .25, pointRadius: 3 },
        { label: 'Médio', data: h.map(p => p.media), borderColor: c2, backgroundColor: c2, tension: .25, pointRadius: 3 },
        ...(own ? [{ label: 'Seu preço', data: h.map(() => own), borderColor: cor('--danger'), borderDash: [6, 4], pointRadius: 0, borderWidth: 2 }] : [])
      ] },
      options: opcoesBase()
    });

    const vend = P.vendedores(visiveis);
    const maxV = vend.length ? vend[0].total : 1;
    $('#sellers').innerHTML = vend.length ? vend.map(v =>
      `<div class="rank-row"><span title="${esc(v.nome)}">${esc(v.nome)}</span><div class="bar"><i style="width:${(v.total / maxV) * 100}%"></i></div><b>${v.total}</b></div>`
    ).join('') : '<div class="empty">Sem vendedores identificados.</div>';

    $('#snapshots').innerHTML = snapshots.length ? snapshots.slice().reverse().map(s =>
      `<div class="snap"><div><b>${esc(s.nome || 'Importação')}</b><small>${esc(fmtData(new Date(s.exportado_em || s.criado_em)))} · ${num.format(s.total_ofertas)} ofertas</small></div><button class="danger" data-del="${esc(s.id)}">Apagar</button></div>`
    ).join('') : '<div class="empty">Nenhuma importação.</div>';

    renderTabela(own);
  }

  function renderTabela(own) {
    const { campo, asc } = ordem;
    const lista = visiveis.slice().sort((a, b) => {
      const x = a[campo] ?? '', y = b[campo] ?? '';
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'pt-BR');
      return asc ? c : -c;
    });
    const LIM = 500;
    $('#table-count').textContent = lista.length > LIM ? `(${num.format(LIM)} de ${num.format(lista.length)})` : `(${num.format(lista.length)})`;
    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.classList.toggle('sorted', th.dataset.sort === campo);
      th.classList.toggle('asc', th.dataset.sort === campo && asc);
    });
    $('#offers').innerHTML = lista.length ? lista.slice(0, LIM).map(o => {
      const tags = [o.ours && 'Nosso', o.promotion && 'Promoção', o.freeShipping && 'Frete grátis', o.full && 'Full'].filter(Boolean)
        .map(t => `<span class="tag">${t}</span>`).join('');
      const nome = o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">${esc(o.name)}</a>` : esc(o.name);
      return `<tr><td class="name">${nome}<br>${tags}</td><td class="num ${own && o.price < own ? 'below' : ''}">${money.format(o.price)}</td><td>${esc(o.marketplace)}</td><td>${esc(o.seller) || '—'}</td><td class="num">${o.sales != null ? num.format(o.sales) : '—'}</td><td>${esc(fmtData(o.date))}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">Nenhuma oferta para os filtros atuais.</td></tr>';
  }

  function baixar(nome, conteudo, tipo) {
    const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    const a = Object.assign(document.createElement('a'), { href: url, download: nome });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- Eventos ----------
  function ligarEventos() {
    ['#f-text', '#f-own'].forEach(s => $(s).addEventListener('input', render));
    ['#f-market', '#f-snapshot'].forEach(s => $(s).addEventListener('change', render));
    $('#f-own').addEventListener('change', () => { try { localStorage.setItem('sr-meu-preco', $('#f-own').value); } catch {} });
    try { $('#f-own').value = localStorage.getItem('sr-meu-preco') || ''; } catch {}

    document.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
      ordem = { campo: th.dataset.sort, asc: ordem.campo === th.dataset.sort ? !ordem.asc : true };
      renderTabela(meuPreco());
    }));

    const drop = $('#drop-zone');
    $('#file-input').addEventListener('change', e => { importarArquivos(e.target.files); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => importarArquivos(e.dataTransfer.files));

    $('#snapshots').addEventListener('click', async e => {
      const id = e.target.dataset.del;
      if (!id || !confirm('Apagar esta importação? Os dados dela saem do histórico.')) return;
      try {
        await store.remover(id);
        snapshots = snapshots.filter(s => String(s.id) !== id);
        reconstruirOfertas(); preencherFiltros(); render();
        msg($('#app-msg'), 'Importação apagada.', 'ok');
      } catch (err) { msg($('#app-msg'), `Erro ao apagar: ${err.message}`, 'error'); }
    });

    const stamp = () => new Date().toISOString().slice(0, 10);
    $('#export-csv').addEventListener('click', () => visiveis.length && baixar(`ofertas-${stamp()}.csv`, P.paraCSV(visiveis), 'text/csv;charset=utf-8'));
    $('#export-json').addEventListener('click', () => visiveis.length && baixar(`ofertas-${stamp()}.json`,
      JSON.stringify({ app: 'shopping-radar-painel', exportadoEm: new Date().toISOString(), ofertas: visiveis }, null, 2), 'application/json'));

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => snapshots.length && render());
  }

  // ---------- Login ----------
  let modoAuth = 'entrar';
  function ajustarAuth() {
    const criar = modoAuth === 'criar';
    $('#auth-title').textContent = criar ? 'Criar conta' : 'Entrar';
    $('#auth-submit').textContent = criar ? 'Criar conta' : 'Entrar';
    $('#auth-toggle').textContent = criar ? 'Já tem conta? Entrar' : 'Não tem conta? Criar conta';
    $('#auth-password').autocomplete = criar ? 'new-password' : 'current-password';
    msg($('#auth-msg'), '');
  }

  function ligarAuth() {
    const redirect = location.origin + location.pathname;
    $('#auth-toggle').addEventListener('click', () => { modoAuth = modoAuth === 'criar' ? 'entrar' : 'criar'; ajustarAuth(); });
    $('#auth-forgot').addEventListener('click', async () => {
      const email = $('#auth-email').value.trim();
      if (!email) return msg($('#auth-msg'), 'Digite seu e-mail acima primeiro.', 'error');
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirect });
      msg($('#auth-msg'), error ? error.message : 'Enviamos um link para redefinir a senha.', error ? 'error' : 'ok');
    });
    $('#auth-form').addEventListener('submit', async e => {
      e.preventDefault();
      const email = $('#auth-email').value.trim(), password = $('#auth-password').value;
      $('#auth-submit').disabled = true;
      try {
        if (modoAuth === 'criar') {
          const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirect } });
          if (error) throw error;
          if (!data.session) msg($('#auth-msg'), 'Conta criada! Confirme pelo link enviado ao seu e-mail e depois entre.', 'ok');
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
        }
      } catch (err) {
        msg($('#auth-msg'), /invalid login/i.test(err.message) ? 'E-mail ou senha incorretos.' : err.message, 'error');
      } finally { $('#auth-submit').disabled = false; }
    });
    $('#logout-btn').addEventListener('click', () => sb.auth.signOut());

    sb.auth.onAuthStateChange(async (evento, sessao) => {
      if (evento === 'PASSWORD_RECOVERY') {
        const nova = prompt('Digite a nova senha (mínimo 6 caracteres):');
        if (nova) {
          const { error } = await sb.auth.updateUser({ password: nova });
          alert(error ? `Erro: ${error.message}` : 'Senha alterada!');
        }
      }
      if (sessao) {
        $('#user-box').hidden = false;
        $('#user-email').textContent = sessao.user.email;
        if (store !== storeSupabase) { store = storeSupabase; mostrar('app'); carregar(); }
      } else {
        store = null; snapshots = []; ofertas = [];
        $('#user-box').hidden = true;
        mostrar('auth');
      }
    });
  }

  // ---------- Início ----------
  ligarEventos();
  if (temSupabase) {
    ajustarAuth();
    ligarAuth();
  } else {
    mostrar('setup');
    const abrirDemo = () => {
      store = storeDemo();
      $('#demo-banner').hidden = false;
      mostrar('app');
      carregar();
    };
    $('#demo-btn').addEventListener('click', abrirDemo);
    if (/[?&]demo\b/.test(location.search)) abrirDemo();
  }
})();
