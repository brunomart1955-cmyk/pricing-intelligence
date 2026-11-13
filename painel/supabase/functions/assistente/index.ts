// Supabase Edge Function "assistente": ponte segura entre o painel e o Gemini.
//
// - A chave do Gemini fica SÓ aqui, como segredo do Supabase (GEMINI_API_KEY);
//   nunca vai para o site nem para o GitHub.
// - Só atende quem está logado E aprovado pelo admin (função sou_aprovado()).
// - Modelo configurável pelo segredo GEMINI_MODEL (padrão abaixo).
//
// Deploy pelo painel do Supabase: Edge Functions → Deploy a new function →
// Via Editor → nome "assistente" → cole este arquivo → Deploy.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const MODELO_PADRAO = 'gemini-2.5-flash';
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
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ erro: 'Faça login no painel.' }, 401);
    const { data: aprovado, error: erroAcesso } = await sb.rpc('sou_aprovado');
    if (erroAcesso || !aprovado) return json({ erro: 'Sua conta ainda não foi aprovada pelo administrador.' }, 403);

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

    const modelo = Deno.env.get('GEMINI_MODEL') || MODELO_PADRAO;
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: contexto ? `${SISTEMA}\n\nDADOS:\n${contexto}` : SISTEMA }] },
        contents: mensagens,
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
      }),
    });
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = resp.status === 429
        ? 'Limite gratuito do Gemini atingido no momento. Espere um minuto e tente de novo.'
        : `Gemini respondeu com erro: ${dados?.error?.message ?? resp.status}`;
      return json({ erro: msg }, 502);
    }
    const texto = (dados?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('').trim();
    if (!texto) return json({ erro: 'O Gemini não retornou resposta (pode ter sido bloqueada por filtro de segurança).' }, 502);
    return json({ texto, modelo });
  } catch (e) {
    return json({ erro: `Falha no assistente: ${(e as Error).message}` }, 500);
  }
});
