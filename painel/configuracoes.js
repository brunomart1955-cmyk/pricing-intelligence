// Aba "Configurações": preferências pessoais (todos) + ajustes gerais (só admin).
// Os ajustes gerais ficam na tabela "configuracoes" do Supabase (ver configuracoes.sql)
// e são lidos pelo painel, pela Edge Function do assistente e pela extensão.
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const app = () => window.SRApp;
  const sb = () => app()?.sb;
  const fmtData = ms => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const esc = v => { const e = document.createElement('span'); e.textContent = v ?? ''; return e.innerHTML; };
  const lista = texto => String(texto || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
  const precoTexto = n => (typeof n === 'number' && n > 0 ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '');

  const MARKETPLACES = ['Google Shopping', 'Mercado Livre', 'Magalu', 'Shopee', 'Amazon', 'AliExpress', 'Shop Coopera'];
  const PADROES = {
    assistente: { ativo: true, modelo: '', instrucoes: '', temperatura: 0.4, limiteDiario: 50 },
    acesso: { dominiosAuto: [] },
    acesso_publico: { cadastroAberto: true, mensagemEspera: '' },
    extensao: { modoLeitura: 'usuario', marketplacesAtivos: [], nomesLoja: [], precoPadrao: null }
  };

  const estado = {
    prefs: {},          // preferências pessoais
    publico: null,      // acesso_publico (lido antes do login)
    gerais: {},         // demais configurações (admin)
    semTabela: false    // configuracoes.sql ainda não foi rodado
  };

  function msg(el, texto, tipo) { el.textContent = texto || ''; el.className = `msg ${tipo || ''}`; }
  const tabelaFaltando = e => e && /(configuracoes|preferencias)/.test(e.message || '') && /(find|exist|schema cache)/i.test(e.message || '');

  // ---------- Tema ----------
  function aplicarTema(tema) {
    if (tema === 'light' || tema === 'dark') document.documentElement.dataset.theme = tema;
    else delete document.documentElement.dataset.theme;
    try { tema ? localStorage.setItem('sr-tema', tema) : localStorage.removeItem('sr-tema'); } catch {}
    window.dispatchEvent(new Event('sr-tema'));
  }

  // ---------- Antes do login: "Criar conta" e mensagem de espera ----------
  async function carregarPublico() {
    if (!sb()) return;
    const { data, error } = await sb().from('configuracoes').select('valor').eq('chave', 'acesso_publico').maybeSingle();
    if (error) return;
    estado.publico = { ...PADROES.acesso_publico, ...(data?.valor || {}) };
    $('#auth-toggle').hidden = estado.publico.cadastroAberto === false;
  }

  // ---------- Ao entrar (conta aprovada) ----------
  async function aoEntrar(acesso) {
    estado.acesso = acesso;
    const { data, error } = await sb().from('preferencias').select('dados').maybeSingle();
    estado.semTabela = tabelaFaltando(error);
    estado.prefs = data?.dados || {};
    if (estado.prefs.tema !== undefined) aplicarTema(estado.prefs.tema);
    if (estado.prefs.precoReferencia) app().aplicarPrecoReferencia(precoTexto(estado.prefs.precoReferencia));
  }

  // ---------- Abrir a aba ----------
  async function abrir() {
    const admin = Boolean(estado.acesso?.admin);
    document.querySelectorAll('#view-configuracoes .so-admin').forEach(s => { s.hidden = !admin; });
    const aviso = $('#cfg-aviso');
    aviso.hidden = !estado.semTabela;
    aviso.textContent = estado.semTabela ? 'Falta rodar o arquivo configuracoes.sql no SQL Editor do Supabase para salvar as configurações.' : '';

    preencherPrefs();
    if (admin) await carregarGerais();
  }

  function preencherPrefs() {
    const p = estado.prefs;
    $('#pref-tema').value = p.tema || '';
    $('#pref-preco').value = precoTexto(p.precoReferencia);
    const canais = [...new Set([...MARKETPLACES, ...app().getOfertas().map(o => o.marketplace)])].filter(Boolean).sort();
    $('#pref-market').innerHTML = '<option value="">Todos</option>' + canais.map(c => `<option>${esc(c)}</option>`).join('');
    $('#pref-market').value = p.marketplacePadrao || '';
  }

  async function salvarPrefs(e) {
    e.preventDefault();
    const preco = app().P.parsePreco($('#pref-preco').value);
    if ($('#pref-preco').value.trim() && !preco) return msg($('#pref-msg'), 'Preço inválido. Use, por exemplo, 952,00.', 'error');
    const dados = { ...estado.prefs, tema: $('#pref-tema').value, precoReferencia: preco || null, marketplacePadrao: $('#pref-market').value };
    const { error } = await sb().from('preferencias').upsert({ user_id: app().getUsuarioId(), dados, atualizado_em: new Date().toISOString() });
    if (error) return msg($('#pref-msg'), tabelaFaltando(error) ? 'Falta rodar o configuracoes.sql no Supabase.' : `Erro: ${error.message}`, 'error');
    estado.prefs = dados;
    aplicarTema(dados.tema);
    app().aplicarPrecoReferencia(precoTexto(dados.precoReferencia));
    const filtro = $('#f-market');
    if ([...filtro.options].some(o => o.value === dados.marketplacePadrao)) { filtro.value = dados.marketplacePadrao; filtro.dispatchEvent(new Event('change')); }
    msg($('#pref-msg'), 'Preferências salvas.', 'ok');
  }

  async function apagarMeusDados() {
    const ok = prompt('Isso apaga TODAS as suas importações e envios da extensão. Para confirmar, digite APAGAR:');
    if (ok !== 'APAGAR') return;
    const { error } = await sb().from('snapshots').delete().eq('user_id', app().getUsuarioId());
    if (error) return msg($('#pref-msg'), `Erro ao apagar: ${error.message}`, 'error');
    msg($('#pref-msg'), 'Seus dados de preços foram apagados. A extensão volta a enviar na próxima coleta.', 'ok');
    app().recarregar();
  }

  // ---------- Configurações gerais (admin) ----------
  async function carregarGerais() {
    const { data, error } = await sb().from('configuracoes').select('chave, valor, atualizado_em');
    if (error) {
      estado.semTabela = tabelaFaltando(error);
      $('#cfg-aviso').hidden = false;
      $('#cfg-aviso').textContent = estado.semTabela ? 'Falta rodar o arquivo configuracoes.sql no SQL Editor do Supabase para salvar as configurações.' : `Erro ao carregar configurações: ${error.message}`;
      return;
    }
    estado.gerais = {};
    Object.keys(PADROES).forEach(k => { estado.gerais[k] = { ...PADROES[k], ...(data.find(l => l.chave === k)?.valor || {}) }; });

    const a = estado.gerais.assistente;
    $('#as-ativo').checked = a.ativo !== false;
    $('#as-modelo').value = a.modelo || '';
    $('#as-limite').value = Number(a.limiteDiario) || 0;
    $('#as-temp').value = Number.isFinite(Number(a.temperatura)) ? a.temperatura : 0.4;
    $('#as-temp-valor').textContent = Number($('#as-temp').value).toFixed(1).replace('.', ',');
    $('#as-instrucoes').value = a.instrucoes || '';

    const pub = estado.gerais.acesso_publico;
    $('#ac-cadastro').checked = pub.cadastroAberto !== false;
    $('#ac-mensagem').value = pub.mensagemEspera || '';
    $('#ac-dominios').value = (estado.gerais.acesso.dominiosAuto || []).join(', ');

    const x = estado.gerais.extensao;
    $('#ex-modo').value = x.modoLeitura || 'usuario';
    $('#ex-preco').value = precoTexto(x.precoPadrao);
    $('#ex-lojas').value = (x.nomesLoja || []).join(', ');
    const ativos = x.marketplacesAtivos || [];
    $('#ex-markets').innerHTML = MARKETPLACES.map(m =>
      `<label class="check"><input type="checkbox" value="${esc(m)}" ${ativos.includes(m) ? 'checked' : ''}> ${esc(m)}</label>`).join('');

    carregarUso();
  }

  async function carregarUso() {
    const alvo = $('#as-uso');
    const hoje = new Date().toISOString().slice(0, 10);
    const [{ data: uso, error }, { data: contas }] = await Promise.all([
      sb().from('uso_assistente').select('user_id, perguntas').eq('dia', hoje).order('perguntas', { ascending: false }),
      sb().from('acessos').select('user_id, email')
    ]);
    if (error) { alvo.innerHTML = '<div class="empty">Sem dados de uso.</div>'; return; }
    const limite = Number(estado.gerais.assistente.limiteDiario) || 0;
    const email = id => contas?.find(c => c.user_id === id)?.email || 'conta removida';
    alvo.innerHTML = uso.length ? uso.map(u =>
      `<div class="snap"><div><b>${esc(email(u.user_id))}</b><small>${u.perguntas} pergunta(s) hoje${limite ? ` de ${limite}` : ''}</small></div></div>`
    ).join('') : '<div class="empty">Ninguém usou o assistente hoje.</div>';
  }

  async function salvarGeral(chaves, msgEl) {
    const agora = new Date().toISOString();
    const linhas = chaves.map(chave => ({ chave, valor: estado.gerais[chave], atualizado_em: agora }));
    const { error } = await sb().from('configuracoes').upsert(linhas);
    if (error) return msg(msgEl, tabelaFaltando(error) ? 'Falta rodar o configuracoes.sql no Supabase.' : `Erro: ${error.message}`, 'error');
    msg(msgEl, `Salvo às ${fmtData(Date.now()).slice(-5)}.`, 'ok');
  }

  function salvarAssistente(e) {
    e.preventDefault();
    const limite = Math.max(0, Math.floor(Number($('#as-limite').value) || 0));
    estado.gerais.assistente = {
      ...estado.gerais.assistente,
      ativo: $('#as-ativo').checked,
      modelo: $('#as-modelo').value.trim().replace(/^models\//, ''),
      limiteDiario: limite,
      temperatura: Number($('#as-temp').value),
      instrucoes: $('#as-instrucoes').value.trim()
    };
    salvarGeral(['assistente'], $('#as-msg'));
  }

  function salvarAcesso(e) {
    e.preventDefault();
    const dominios = lista($('#ac-dominios').value).map(d => d.replace(/^.*@/, '').toLowerCase());
    const invalido = dominios.find(d => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
    if (invalido) return msg($('#ac-msg'), `Domínio inválido: ${invalido}. Use só a parte depois do @, ex.: suaempresa.com.br`, 'error');
    const genericos = dominios.filter(d => /^(gmail|hotmail|outlook|yahoo|live|icloud|bol|uol)\./.test(d));
    if (genericos.length && !confirm(`Atenção: ${genericos.join(', ')} é um e-mail público — QUALQUER pessoa com esse tipo de e-mail entraria aprovada. Continuar mesmo assim?`)) return;
    estado.gerais.acesso = { ...estado.gerais.acesso, dominiosAuto: dominios };
    estado.gerais.acesso_publico = { ...estado.gerais.acesso_publico, cadastroAberto: $('#ac-cadastro').checked, mensagemEspera: $('#ac-mensagem').value.trim() };
    estado.publico = estado.gerais.acesso_publico;
    salvarGeral(['acesso', 'acesso_publico'], $('#ac-msg'));
  }

  function salvarExtensao(e) {
    e.preventDefault();
    const preco = app().P.parsePreco($('#ex-preco').value);
    if ($('#ex-preco').value.trim() && !preco) return msg($('#ex-msg'), 'Preço inválido. Use, por exemplo, 952,00.', 'error');
    estado.gerais.extensao = {
      ...estado.gerais.extensao,
      modoLeitura: $('#ex-modo').value,
      precoPadrao: preco || null,
      nomesLoja: lista($('#ex-lojas').value),
      marketplacesAtivos: [...document.querySelectorAll('#ex-markets input:checked')].map(i => i.value)
    };
    salvarGeral(['extensao'], $('#ex-msg'));
  }

  // ---------- Eventos ----------
  $('#form-pref').addEventListener('submit', salvarPrefs);
  $('#pref-apagar').addEventListener('click', apagarMeusDados);
  $('#form-assistente').addEventListener('submit', salvarAssistente);
  $('#form-acesso').addEventListener('submit', salvarAcesso);
  $('#form-extensao').addEventListener('submit', salvarExtensao);
  $('#as-temp').addEventListener('input', () => { $('#as-temp-valor').textContent = Number($('#as-temp').value).toFixed(1).replace('.', ','); });

  window.SRConfig = {
    aoEntrar, abrir, carregarPublico,
    get prefs() { return estado.prefs; },
    get publico() { return estado.publico; }
  };
  carregarPublico();
})();
