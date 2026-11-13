// Barra "Painel online" dos dashboards da extensão: login, status da
// sincronização automática e atalhos. A lógica fica no nuvem.js (background).
(function () {
  const box = document.getElementById('nuvem');
  if (!box) return;
  const esc = t => { const e = document.createElement('span'); e.textContent = t ?? ''; return e.innerHTML; };
  const hora = ms => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const enviar = msg => chrome.runtime.sendMessage(msg);

  let status = {};
  let ocupado = false;
  let erroLocal = '';

  function render() {
    if (status.conectado) {
      const linha = status.erro ? `<span class="nuvem-erro">${esc(status.erro)}</span>`
        : status.aviso ? esc(status.aviso)
        : status.ultimaSync ? `Sincronizado automaticamente · último envio ${esc(hora(status.ultimaSync))} (${status.ultimoTotal} ofertas)`
        : 'Conectado. As ofertas coletadas serão enviadas automaticamente.';
      box.innerHTML = `
        <div class="nuvem-info"><b>☁ Painel online</b><span>Conectado como <b>${esc(status.email)}</b></span><small>${linha}</small></div>
        <div class="nuvem-acoes">
          <button id="nuvem-sync" ${ocupado ? 'disabled' : ''}>${ocupado ? 'Enviando…' : '↑ Enviar agora'}</button>
          <button id="nuvem-abrir">Abrir painel</button>
          <button id="nuvem-sair" class="nuvem-sec">Sair</button>
        </div>`;
      box.querySelector('#nuvem-sync').onclick = async () => {
        ocupado = true; render();
        await enviar({ type: 'nuvem-sync' }).catch(() => {});
        ocupado = false; render();
      };
      box.querySelector('#nuvem-abrir').onclick = () => enviar({ type: 'nuvem-abrir-painel' });
      box.querySelector('#nuvem-sair').onclick = () => enviar({ type: 'nuvem-logout' });
    } else {
      const erro = erroLocal || status.erro || '';
      box.innerHTML = `
        <div class="nuvem-info"><b>☁ Painel online</b><small>Entre com a conta do painel para salvar e ver o histórico de preços automaticamente.</small>
          ${erro ? `<small class="nuvem-erro">${esc(erro)}</small>` : ''}</div>
        <form id="nuvem-form" class="nuvem-acoes">
          <input id="nuvem-email" type="email" placeholder="E-mail" autocomplete="email" required>
          <input id="nuvem-senha" type="password" placeholder="Senha" autocomplete="current-password" required>
          <button type="submit" ${ocupado ? 'disabled' : ''}>${ocupado ? 'Entrando…' : 'Entrar'}</button>
          <button type="button" id="nuvem-criar" class="nuvem-sec">Criar conta</button>
        </form>`;
      box.querySelector('#nuvem-criar').onclick = () => enviar({ type: 'nuvem-abrir-painel' });
      box.querySelector('#nuvem-form').onsubmit = async e => {
        e.preventDefault();
        const email = box.querySelector('#nuvem-email').value, senha = box.querySelector('#nuvem-senha').value;
        ocupado = true; erroLocal = ''; render();
        box.querySelector('#nuvem-email').value = email;
        const r = await enviar({ type: 'nuvem-login', email, senha }).catch(err => ({ ok: false, erro: err.message }));
        ocupado = false;
        if (!r?.ok && !status.conectado) erroLocal = r?.erro || 'Não foi possível entrar.';
        render();
        if (!status.conectado) box.querySelector('#nuvem-email').value = email;
      };
    }
  }

  chrome.storage.local.get('nuvemStatus', ({ nuvemStatus = {} }) => { status = nuvemStatus; render(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.nuvemStatus) {
      status = changes.nuvemStatus.newValue || {};
      if (status.conectado) erroLocal = '';
      if (!ocupado) render();
    }
  });
})();
