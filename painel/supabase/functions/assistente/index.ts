// Supabase Edge Function "assistente": ponte segura entre o painel e o Gemini.
//
// - A chave do Gemini fica SÓ aqui, como segredo do Supabase (GEMINI_API_KEY);
//   nunca vai para o site nem para o GitHub.
// - Só atende quem está logado E aprovado pelo admin (função sou_aprovado()).
// - Ajustes vêm da aba Configurações (tabela "configuracoes", chave "assistente"):
//   IA ligada/desligada, modelo, instruções da loja, temperatura e limite diário.
//   Se a tabela não existir, usa o segredo GEMINI_MODEL / os padrões abaixo.
//
// Deploy pelo painel do Supabase: Edge Functions → Deploy a new function →
// Via Editor → nome "assistente" → cole este arquivo → Deploy.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const MODELO_PADRAO = 'gemini-3.8-flash';
const MAX_MENSAGENS = 20;
const MAX_TEXTO = 8000;
const MAX_CONTEXTO = 60000;

const SISTEMA = `Você é o assistente de inteligência comercial da loja, dentro do painel Shopping Radar.
Responda sempre em português do Brasil, de forma direta e prática, como um analista de e-commerce experiente.
Quando houver DADOS abaixo, baseie a resposta neles e cite números concretos; se os dados não forem suficientes para responder, diga isso claramente em vez de inventar.
Prefira listas curtas e recomendações acionáveis (preço, estoque, anúncios, campanhas).`;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ erro: 'Use POST.' }, 405);

  try {
    // Cliente com o token de quem chamou: as regras (RLS) valem como se fosse o próprio usuário.
    // Chave pública (publishable): projetos novos podem não ter SUPABASE_ANON_KEY.
    const chavePublica = Deno.env.get('SUPABASE_ANON_KEY') || 'sb_publishable_nBsq0Xy8Vi6ZBrbL_BrzdQ_c3JNnBrO';
    const sb = createClient(Deno.env.get('SUPABASE_URL') || 'https://lmazvxvudbhoivgvhbin.supabase.co', chavePublica, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ erro: 'Faça login no painel.' }, 401);
    const { data: aprovado, error: erroAcesso } = await sb.rpc('sou_aprovado');
    if (erroAcesso || !aprovado) return json({ erro: 'Sua conta ainda não foi aprovada pelo administrador.' }, 403);

    // Configurações definidas pelo admin no painel (opcional).
    const { data: linhaCfg } = await sb.from('configuracoes').select('valor').eq('chave', 'assistente').maybeSingle();
    const cfg = (linhaCfg?.valor ?? {}) as Record<string, any>;
    if (cfg.ativo === false) return json({ erro: 'O assistente está desligado pelo administrador.' }, 403);

    const chave = Deno.env.get('GEMINI_API_KEY');
    if (!chave) return json({ erro: 'O administrador ainda não configurou a chave do Gemini (segredo GEMINI_API_KEY).' }, 500);

    const corpo = await req.json().catch(() => ({}));
    const mensagens = (Array.isArray(corpo.mensagens) ? corpo.mensagens : [])
      .filter((m: any) => m && typeof m.texto === 'string' && m.texto.trim())
      .slice(-MAX_MENSAGENS)
      .map((m: any) => ({
        role: m.papel === 'assistente' ? 'model' : 'user',
        parts: [{ text: m.texto.slice(0, MAX_TEXTO) }],
      }));
    if (!mensagens.length || mensagens[mensagens.length - 1].role !== 'user') {
      return json({ erro: 'Envie uma pergunta.' }, 400);
    }
    const contexto = typeof corpo.contexto === 'string' ? corpo.contexto.slice(0, MAX_CONTEXTO) : '';

    // Limite diário por usuário (conta a pergunta). Sem a função no banco, segue sem limite.
    const { data: uso, error: erroUso } = await sb.rpc('registrar_pergunta');
    if (!erroUso && uso && uso.ok === false) {
      return json({ erro: `Você já fez as ${uso.limite} perguntas permitidas hoje. O limite renova amanhã.` }, 429);
    }

    const instrucoes = typeof cfg.instrucoes === 'string' ? cfg.instrucoes.trim().slice(0, 4000) : '';
    const sistema = [
      SISTEMA,
      instrucoes && `INSTRUÇÕES DA LOJA (definidas pelo administrador):\n${instrucoes}`,
      contexto && `DADOS:\n${contexto}`,
    ].filter(Boolean).join('\n\n');
    const temp = Number(cfg.temperatura);
    const temperatura = Number.isFinite(temp) ? Math.min(1, Math.max(0, temp)) : 0.4;

    let modelo = String(cfg.modelo || '').trim() || Deno.env.get('GEMINI_MODEL') || MODELO_PADRAO;
    const chamar = (m: string) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sistema }] },
        contents: mensagens,
        generationConfig: { temperature: temperatura, maxOutputTokens: 2048 },
      }),
    });
    const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const sobrecarga = (status: number) => status === 503 || status === 500;
    let resp = await chamar(modelo);
    let dados = await resp.json().catch(() => ({}));
    // Modelo aposentado: o Google costuma sugerir o substituto ("use models/xxx").
    // Nesse caso tenta de novo, uma vez, com o modelo sugerido.
    const sugerido = !resp.ok && String(dados?.error?.message ?? '').match(/use models\/([\w.-]+)/i)?.[1];
    if (sugerido && sugerido !== modelo) {
      modelo = sugerido;
      resp = await chamar(modelo);
      dados = await resp.json().catch(() => ({}));
    }
    // Gemini sobrecarregado ("high demand"): espera um pouco e tenta de novo;
    // se continuar, cai para a versão "lite" do mesmo modelo (costuma estar livre).
    if (sobrecarga(resp.status)) {
      const tentativas = [modelo, ...(/-lite$/.test(modelo) ? [] : [`${modelo}-lite`])];
      for (const m of tentativas) {
        await espera(1500);
        const r = await chamar(m);
        const d = await r.json().catch(() => ({}));
        if (r.ok || !sobrecarga(r.status) && r.status !== 404) { resp = r; dados = d; modelo = m; }
        if (r.ok) break;
      }
    }
    if (!resp.ok) {
      const msg = resp.status === 429
        ? 'Limite gratuito do Gemini atingido no momento. Espere um minuto e tente de novo.'
        : sobrecarga(resp.status)
          ? 'O Gemini está sobrecarregado agora (alta demanda no Google). Tente de novo em alguns minutos.'
          : `Gemini respondeu com erro: ${dados?.error?.message ?? resp.status}`;
      return json({ erro: msg }, 502);
    }
    const texto = (dados?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('').trim();
    if (!texto) return json({ erro: 'O Gemini não retornou resposta (pode ter sido bloqueada por filtro de segurança).' }, 502);
    return json({ texto, modelo, uso: erroUso ? null : uso });
  } catch (e) {
    return json({ erro: `Falha no assistente: ${(e as Error).message}` }, 500);
  }
});
