# Shopping Radar · Painel

Painel web do [Shopping Radar](../README.md): login por e-mail, histórico salvo por usuário e visualizações dos dados exportados pela extensão.

**Demonstração (sem login, dados fictícios):** https://brunomart1955-cmyk.github.io/pricing-intelligence/painel/?demo

## O que faz
- Login, cadastro e recuperação de senha (Supabase Auth).
- Importa o JSON do botão **⬇ Exportar JSON** da extensão (arrastar e soltar, vários arquivos de uma vez).
- Cada importação vira um "snapshot" salvo na conta, o que monta o **histórico de preços** ao longo do tempo.
- Indicadores (ofertas, menor preço, preço médio, quantas ofertas estão abaixo do seu preço), gráfico por marketplace, ranking de vendedores e tabela ordenável.
- Exporta a visão filtrada em CSV (abre direto no Excel) ou JSON.

## Configurar (uma vez)
1. Crie um projeto gratuito em https://supabase.com.
2. **SQL Editor → New query**: cole o conteúdo de [`supabase.sql`](supabase.sql) e clique em **Run**. Isso cria a tabela `snapshots` com RLS: cada usuário só acessa os próprios dados.
3. **Authentication → URL Configuration**: em *Site URL* coloque `https://brunomart1955-cmyk.github.io/pricing-intelligence/painel/`.
4. **Project Settings → API**: copie a *Project URL* e a *anon public key* para o [`config.js`](config.js) e faça commit.

A anon key pode ficar pública; quem protege os dados é o RLS. **Nunca** use a `service_role` key no site.

## Estrutura
| Arquivo | Função |
|---|---|
| `index.html`, `styles.css` | Interface (tema claro/escuro automático, responsivo) |
| `app.js` | Login, importação, gráficos (Chart.js) e tabela |
| `processamento.js` | Normaliza o JSON da extensão e calcula as métricas (funções puras) |
| `supabase.sql` | Tabela e regras de segurança |
| `tests/` | `node --test tests/processamento.test.mjs` |

## Formatos de JSON aceitos
- Export da extensão: `{ "app": "shopping-radar", "google": {...}, "marketplaces": { "Mercado Livre": { "products": [...] } } }`
- Dump do `chrome.storage`: `{ "shoppingRadarData": {...}, "marketplaceRadarData": {...} }`
- Lista simples: `[ { "name": "...", "price": 99.9, "source": "Amazon", "seller": "..." } ]`
