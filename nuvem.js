// Conexão da extensão com o painel online (Supabase).
// Roda no service worker (importado pelo background.js).
//
// - Login com a mesma conta do site (e-mail e senha). A senha NÃO é salva:
//   guardamos só os tokens da sessão, que são renovados sozinhos.
// - Sincronização automática: sempre que a extensão grava ofertas novas, um
//   alarme de ~30s agrupa as mudanças e envia tudo para a tabela "snapshots".
//   Existe um snapshot por dia: no mesmo dia ele é atualizado, no dia seguinte
//   nasce outro — é isso que forma o histórico de preços no painel.

const NUVEM = {
  url: 'https://lmazvxvudbhoivgvhbin.supabase.co',
  chave: 'sb_publishable_nBsq0Xy8Vi6ZBrbL_BrzdQ_c3JNnBrO', // chave pública (protegida por RLS)
  painel: 'https://brunomart1955-cmyk.github.io/pricing-intelligence/painel/'
};
const NUVEM_ALARME = 'nuvem-sync';
const CHAVES_DADOS = ['shoppingRadarData', 'marketplaceRadarData'];

const storageGet = keys => chrome.storage.local.get(keys);
const storageSet = obj => chrome.storage.local.set(obj);

async function nuvemStatus(patch) {
  const { nuvemStatus: atual = {} } = await storageGet('nuvemStatus');
  const novo = { ...atual, ...patch };
  await storageSet({ nuvemStatus: novo });
  return novo;
}

async function authRequest(grantType, body) {
  const resp = await fetch(`${NUVEM.url}/auth/v1/token?grant_type=${grantType}`, {
    method: 'POST',
    headers: { apikey: NUVEM.chave, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data.error_description || data.msg || data.message || `Erro ${resp.status}`;
    throw new Error(/invalid login/i.test(msg) ? 'E-mail ou senha incorretos.'
      : /not confirmed/i.test(msg) ? 'Confirme seu e-mail pelo link enviado antes de entrar.' : msg);
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    email: data.user?.email || '',
    user_id: data.user?.id || ''
  };
}

async function nuvemLogin(email, senha) {
  const sessao = await authRequest('password', { email, password: senha });
  await storageSet({ nuvemSessao: sessao });
  await nuvemStatus({ conectado: true, email: sessao.email, erro: '' });
  return nuvemSincronizar({ forcar: true });
}

async function nuvemLogout() {
  const { nuvemSessao } = await storageGet('nuvemSessao');
  if (nuvemSessao?.access_token) {
    fetch(`${NUVEM.url}/auth/v1/logout`, {
      method: 'POST', headers: { apikey: NUVEM.chave, Authorization: `Bearer ${nuvemSessao.access_token}` }
    }).catch(() => {});
  }
  await chrome.storage.local.remove(['nuvemSessao', 'nuvemSync']);
  await storageSet({ nuvemStatus: { conectado: false } });
}

async function tokenValido() {
  const { nuvemSessao: s } = await storageGet('nuvemSessao');
  if (!s?.refresh_token) return null;
  if (s.expires_at - 90 > Date.now() / 1000) return s.access_token;
  try {
    const nova = await authRequest('refresh_token', { refresh_token: s.refresh_token });
    await storageSet({ nuvemSessao: { ...s, ...nova, email: nova.email || s.email } });
    return nova.access_token;
  } catch (e) {
    // Sessão expirada de vez (ex.: senha trocada): pede login de novo.
    await chrome.storage.local.remove('nuvemSessao');
    await nuvemStatus({ conectado: false, erro: 'Sessão expirada. Entre novamente.' });
    return null;
  }
}

function contarOfertas(google, marketplaces) {
  let total = Array.isArray(google?.products) ? google.products.length : 0;
  Object.values(marketplaces || {}).forEach(b => { if (Array.isArray(b?.products)) total += b.products.length; });
  return total;
}

function diaLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function rest(token, metodo, caminho, corpo) {
  const resp = await fetch(`${NUVEM.url}/rest/v1/${caminho}`, {
    method: metodo,
    headers: {
      apikey: NUVEM.chave, Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json', Prefer: 'return=representation'
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data?.message || `Erro ${resp.status} ao enviar`);
  return data;
}

let sincronizando = null;
function nuvemSincronizar(opts = {}) {
  // Evita dois envios ao mesmo tempo (ex.: alarme + botão "Enviar agora").
  if (!sincronizando) sincronizando = sincronizarAgora(opts).finally(() => { sincronizando = null; });
  return sincronizando;
}

async function sincronizarAgora() {
  const token = await tokenValido();
  if (!token) return { ok: false, erro: 'Não conectado.' };

  const { shoppingRadarData: google = null, marketplaceRadarData: marketplaces = {}, nuvemSync = {} } =
    await storageGet([...CHAVES_DADOS, 'nuvemSync']);
  const total = contarOfertas(google, marketplaces);
  if (!total) {
    await nuvemStatus({ conectado: true, erro: '', aviso: 'Nada para enviar ainda: faça uma busca em um marketplace.' });
    return { ok: true, total: 0 };
  }

  const agora = new Date();
  const hoje = diaLocal(agora);
  const registro = {
    nome: `Extensão · ${agora.toLocaleDateString('pt-BR')}`,
    exportado_em: agora.toISOString(),
    total_ofertas: total,
    dados: {
      app: 'shopping-radar', formato: 1, origem: 'extensao',
      versao: chrome.runtime.getManifest().version,
      exportadoEm: agora.toISOString(), google, marketplaces
    }
  };

  try {
    let linhas = [];
    if (nuvemSync.dia === hoje && nuvemSync.snapshotId) {
      linhas = await rest(token, 'PATCH', `snapshots?id=eq.${encodeURIComponent(nuvemSync.snapshotId)}`, registro);
    }
    // Primeiro envio do dia (ou o snapshot de hoje foi apagado no site): cria outro.
    if (!linhas || !linhas.length) linhas = await rest(token, 'POST', 'snapshots', registro);
    const id = linhas[0]?.id;
    await storageSet({ nuvemSync: { dia: hoje, snapshotId: id } });
    await nuvemStatus({ conectado: true, erro: '', aviso: '', ultimaSync: Date.now(), ultimoTotal: total });
    return { ok: true, total };
  } catch (e) {
    await nuvemStatus({ erro: `Falha ao enviar: ${e.message}` });
    return { ok: false, erro: e.message };
  }
}

// Qualquer gravação de ofertas agenda um envio (o alarme recriado "empurra"
// o envio pra frente, agrupando várias mudanças seguidas num só).
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !CHAVES_DADOS.some(k => k in changes)) return;
  const { nuvemSessao } = await storageGet('nuvemSessao');
  if (nuvemSessao) chrome.alarms.create(NUVEM_ALARME, { delayInMinutes: 0.5 });
});

chrome.alarms.onAlarm.addListener(alarme => {
  if (alarme.name === NUVEM_ALARME) void nuvemSincronizar();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const tipo = message?.type;
  if (!tipo || !tipo.startsWith('nuvem-')) return;
  (async () => {
    if (tipo === 'nuvem-login') return nuvemLogin(String(message.email || '').trim(), String(message.senha || ''));
    if (tipo === 'nuvem-logout') { await nuvemLogout(); return { ok: true }; }
    if (tipo === 'nuvem-sync') return nuvemSincronizar({ forcar: true });
    if (tipo === 'nuvem-abrir-painel') { await chrome.tabs.create({ url: NUVEM.painel }); return { ok: true }; }
    return { ok: false, erro: 'Ação desconhecida' };
  })().then(r => sendResponse(r || { ok: true }), e => sendResponse({ ok: false, erro: e.message }));
  return true;
});
