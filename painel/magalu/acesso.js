// Porteiro da Magalu Sales Intelligence.
// Carregado ANTES do app original: exige login com conta aprovada e troca a
// leitura de "dashboard_data.json" / "series_365d.json" (que NÃO ficam no
// GitHub) pelo download do bucket privado "magalu" no Supabase.
(function () {
  'use strict';
  const ARQUIVOS = ['dashboard_data.json', 'series_365d.json'];
  const cfg = window.SR_CONFIG || {};
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const voltar = motivo => { location.replace(`../${motivo ? '#' + motivo : ''}`); };

  function aviso(titulo, texto) {
    const mostrar = () => {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:rgba(8,12,18,.88);font:15px/1.5 system-ui,sans-serif;color:#e6edf3;padding:16px';
      el.innerHTML = `<div style="max-width:440px;background:#161e25;border:1px solid #2a3641;border-radius:12px;padding:24px">
        <h2 style="margin:0 0 8px;font-size:20px">${titulo}</h2><p style="margin:0 0 16px;color:#93a1ae">${texto}</p>
        <a href="../" style="display:inline-block;background:#2dd4bf;color:#04201c;font-weight:600;padding:8px 14px;border-radius:8px;text-decoration:none">Voltar ao painel</a></div>`;
      document.body.append(el);
    };
    if (document.body) mostrar(); else document.addEventListener('DOMContentLoaded', mostrar);
  }

  // Confirma sessão e aprovação uma única vez; os downloads esperam por isso.
  const liberado = (async () => {
    const { data } = await sb.auth.getSession();
    if (!data.session) { voltar(); throw new Error('sem login'); }
    const { data: ac, error } = await sb.from('acessos').select('status').eq('user_id', data.session.user.id).maybeSingle();
    if (!error && ac?.status !== 'aprovado') { voltar(); throw new Error('sem aprovação'); }
    return true;
  })();

  const fetchOriginal = window.fetch.bind(window);
  window.fetch = function (recurso, opcoes) {
    const nome = String(recurso instanceof Request ? recurso.url : recurso).split('/').pop().split('?')[0];
    if (!ARQUIVOS.includes(nome)) return fetchOriginal(recurso, opcoes);
    return liberado.then(async () => {
      const { data, error } = await sb.storage.from('magalu').download(nome);
      if (error || !data) {
        aviso('Dados da Magalu ainda não enviados',
          'Um administrador precisa enviar os arquivos dashboard_data.json e series_365d.json na aba "Usuários" do painel.');
        throw new Error(`Arquivo ${nome} indisponível`);
      }
      return new Response(data, { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  };

  // Atalho de volta para o painel.
  document.addEventListener('DOMContentLoaded', () => {
    const a = document.createElement('a');
    a.href = '../';
    a.textContent = '← Painel';
    a.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:9999;background:#0f766e;color:#fff;font:600 13px system-ui,sans-serif;padding:8px 12px;border-radius:8px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    document.body.append(a);
  });
})();
