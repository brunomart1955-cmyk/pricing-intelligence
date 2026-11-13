# Shopping Radar — leitura local dos marketplaces

Extensão Chrome Manifest V3 para monitorar preços no Google Shopping, Mercado Livre, Magalu, Shopee, Amazon, AliExpress e Shop Coopera.

## Como são obtidos os dados

A extensão não chama APIs nem usa credenciais. Para completar um card, ela abre o próprio link público do anúncio em uma fila controlada e lê somente o HTML que o marketplace entrega para aquela página.

Para cada anúncio, ela coleta e salva: nome da loja/vendedor, quantidade de vendas do próprio anúncio ("vendidos"), há quanto tempo a loja vende (quando o marketplace mostra essa informação) e, como alternativa, a opinião mais antiga encontrada — usada como estimativa de "Tempo mínimo do anúncio" quando o tempo de loja não está disponível. Esses dados ficam disponíveis no armazenamento e no dashboard de Marketplaces; o card do painel flutuante mostra a loja e as vendas do anúncio de forma resumida, mantendo o foco em produto e preço. As vendas totais da loja continuam sendo lidas, mas não aparecem mais no card — era a informação que menos cabia no espaço disponível.

Vendas, avaliações e tempo de loja normalmente aparecem dentro da página do produto, e não na lista de busca. O painel abre cada anúncio em segundo plano para ler esses dados e atualiza o card correspondente automaticamente. Enquanto um anúncio ainda não foi verificado, o card mostra "Carregando informações, recarregue a página." em vez de dar a entender que o dado simplesmente não existe; só depois de verificado (e ainda assim sem achar o dado) é que aparece "não visível".

Essa leitura detalhada (vendedor, vendas e tempo de loja) não é exclusiva do Mercado Livre — ela roda em qualquer um dos quatro marketplaces suportados, já que procura pelos mesmos termos em português ("vendidos", "avaliações", "há X meses") em qualquer página de produto. A qualidade varia: funciona bem onde o texto se parece com o do Mercado Livre (nosso "cobaia" principal) e pode vir incompleta em marketplaces com layout ou vocabulário muito diferente — nesse caso o campo aparece como "não visível" normalmente.

## Sobre o dashboard não perder ofertas

O dashboard acumula as ofertas vistas em cada marketplace em vez de substituir a lista a cada página aberta. Isso evita que abrir a ficha de um único produto (que não é uma lista de busca) apague as ofertas já coletadas em uma pesquisa anterior. Use "Limpar" no painel flutuante para começar do zero naquele marketplace.

## Sobre as abas abertas em segundo plano

Cada anúncio só é aberto em segundo plano uma vez a cada 24 horas, mesmo que algum dado (como "há quanto tempo vende") não apareça naquele anúncio — o painel marca o anúncio como verificado de qualquer forma, em vez de tentar de novo a cada atualização. As leituras acontecem em levas pequenas (até 8 abas por vez) até cobrir todos os anúncios da página. Um progresso "Lendo detalhes dos anúncios: X/Y" aparece no painel flutuante e também no dashboard de Marketplaces enquanto isso roda.

### Ritmo: rápido, mas não idêntico todas as vezes

As abas de uma mesma leva abrem em paralelo — só que em um "pool" de no máximo 3 ao mesmo tempo (ver `DETAIL_CONCURRENCY` em `background.js`), não a leva inteira de uma vez. Abrir tudo junto foi tentado e trouxe cards vazios ("não visível" em tudo): várias abas do mesmo marketplace competindo pelo mesmo processo do navegador não davam tempo da página terminar de ordenar/carregar as opiniões antes da extensão tentar ler. Com o pool de 3, o ritmo continua bem mais rápido que uma aba de cada vez (perto de 3 a 4 segundos entre uma leva e a próxima), sem sobrecarregar. Os tempos de espera continuam usando uma faixa aleatória, não um número fixo, porque um intervalo sempre idêntico é, por si só, um sinal de automação.

Se uma leitura volta totalmente vazia (nenhum dado encontrado), o anúncio não fica "preso" por 24h como os outros — ele tenta de novo em 45 minutos, já que um resultado 100% vazio é mais sinal de que a aba não teve tempo de terminar do que de o anúncio realmente não ter nada. **Anúncios que já ficaram marcados como vazios em versões anteriores da extensão continuam presos até essa marca antiga expirar** — use "Limpar" no painel flutuante ou no dashboard pra forçar uma releitura imediata deles.

## Sobre a avaliação mais antiga

Em cada anúncio, a extensão primeiro clica no link "Mostrar todas as opiniões" (ou equivalente) pra abrir a mini sessão de avaliações dentro da própria página, depois tenta clicar no seletor "Ordenar" e escolher uma opção de ordem cronológica crescente. Quando encontra essa opção, a primeira opinião que aparece na lista reordenada já é a mais antiga — mais confiável do que comparar datas espalhadas pela página. Quando esse seletor não existe ou não tem uma opção assim, ela cai para o modo antigo: carrega várias páginas de opiniões com "carregar mais" e usa a data mais antiga entre todas as encontradas. Tudo isso acontece na mesma aba de leitura — não abre uma segunda aba só para isso.

Como isso demora mais que uma leitura simples, a espera não é mais um tempo fixo: a extensão aguarda o conteúdo da página parar de mudar (em vez de travar num tempo fixo curto demais, que era a causa mais provável dos dados "às vezes aparecerem, às vezes não" entre anúncios parecidos).

## Dashboard de Marketplaces: abas, busca, CSV

O dashboard de Marketplaces agora tem uma aba pra cada loja (Mercado Livre, Magalu, Shopee, Amazon, AliExpress, Shop Coopera) mais uma aba "Todos" com tudo junto — a contagem de ofertas aparece ao lado do nome de cada aba. Os filtros, o comparativo com seu preço e o card de cada oferta funcionam do mesmo jeito dentro de qualquer aba.

- **Buscar em todos os marketplaces**: digite o produto no campo no topo do dashboard e clique em "Buscar em todos". A extensão abre a busca daquele termo em segundo plano em cada marketplace — um de cada vez, com pausas entre eles — sem você precisar visitar cada site manualmente; os cards vão aparecendo no dashboard conforme cada marketplace responde. Se você já estiver numa aba de um marketplace específico (não em "Todos"), a busca é feita só naquele marketplace.
- **Atualizar**: relê os dados salvos e atualiza o painel na hora, útil se uma leitura em segundo plano acabou de terminar.
- **Exportar CSV**: exporta pra um arquivo `.csv` exatamente a lista de ofertas visível na aba atual (já com os filtros aplicados) — loja, produto, preço, vendedor, vendas do anúncio, tempo mínimo do anúncio, avaliações, promoção, frete grátis e link.
- **Limpar**: apaga os dados salvos da aba atual. Na aba "Todos" ela pede confirmação antes, porque apaga todos os marketplaces de uma vez.

### AliExpress e Shop Coopera

Esses dois foram adicionados com a mesma lógica dos demais, mas com uma ressalva: diferente do Mercado Livre (nosso "cobaia"), não foi possível inspecionar a estrutura real da página desses dois sites durante o desenvolvimento — o AliExpress ofusca as classes CSS e muda com frequência, e a Shop Coopera é uma loja VTEX cujo tema pode variar. Por isso a extração de card usa um método mais genérico (segue o próprio link do produto, com respaldo em texto/regex pra título e preço) que tende a funcionar, mas pode precisar de ajuste fino depois de testar nos sites de verdade.

## Instalação

1. Abra `chrome://extensions`.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Selecione esta pasta.
5. Recarregue a extensão após atualizações e abra uma busca ou anúncio em um marketplace suportado.

## Exportar JSON e painel web

No dashboard de Marketplaces, o botão **⬇ Exportar JSON** baixa um arquivo com todos os dados coletados (Google Shopping + marketplaces). Esse arquivo pode ser importado no painel web [painel](painel/) — no ar em https://brunomart1955-cmyk.github.io/pricing-intelligence/painel/, que tem login, salva o histórico de cada usuário e mostra gráficos. A extensão em si continua sem login e sem credenciais.
