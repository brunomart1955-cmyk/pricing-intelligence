// Rodar: node --test tests/processamento.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const P = createRequire(import.meta.url)('../processamento.js');

const exportExtensao = {
  app: 'shopping-radar', formato: 1, exportadoEm: '2026-11-10T12:00:00.000Z',
  google: { currentSearch: 'martelete', updatedAt: 1, products: [
    { name: 'Martelete X', price: 899.9, store: 'Loja A', url: 'https://exemplo.com/a', freeShipping: true } ] },
  marketplaces: {
    'Mercado Livre': { source: 'Mercado Livre', ownItem: 'Martelete', products: [
      { name: 'Martelete X', price: 850, seller_name: 'Loja B', product_sales: '+1000 vendidos', promotion: true, url: 'https://exemplo.com/b' },
      { name: 'Martelete Y', price: 'R$ 1.020,50', seller: 'Loja B', product_sales: '2,5 mil', url: 'javascript:alert(1)' },
      { name: '', price: 10 } ] },
    Magalu: { products: [ { name: 'Martelete Z', price: 0 } ] } }
};

test('normaliza export da extensão', () => {
  const { ofertas, exportadoEm } = P.normalizar(exportExtensao);
  assert.equal(exportadoEm, '2026-11-10T12:00:00.000Z');
  assert.equal(ofertas.length, 3);
  assert.equal(ofertas[0].marketplace, 'Google Shopping');
  assert.equal(ofertas[0].seller, 'Loja A');
  assert.equal(ofertas[1].sales, 1000);
  assert.equal(ofertas[2].price, 1020.5);
  assert.equal(ofertas[2].sales, 2500);
  assert.equal(ofertas[2].url, '', 'URL não-http é descartada');
});

test('aceita dump do chrome.storage e lista simples', () => {
  const dump = { marketplaceRadarData: exportExtensao.marketplaces };
  assert.equal(P.normalizar(dump).ofertas.length, 2);
  assert.equal(P.normalizar([{ name: 'A', price: '10,00', source: 'Amazon' }]).ofertas[0].marketplace, 'Amazon');
});

test('arquivo sem ofertas gera erro claro', () => {
  assert.throws(() => P.normalizar({ marketplaces: {} }), /Nenhuma oferta/);
});

test('parsePreco', () => {
  assert.equal(P.parsePreco('R$ 1.234,56'), 1234.56);
  assert.equal(P.parsePreco('1.234'), 1234);
  assert.equal(P.parsePreco('952.5'), 952.5);
  assert.equal(P.parsePreco('abc'), null);
});

test('resumo, marketplace, histórico e vendedores', () => {
  const o = [
    { name: 'a', price: 100, marketplace: 'ML', seller: 'X', snapshotId: 1, date: 2 },
    { name: 'b', price: 200, marketplace: 'ML', seller: 'X', snapshotId: 1, date: 2 },
    { name: 'c', price: 150, marketplace: 'Amazon', seller: 'Y', snapshotId: 0, date: 1 } ];
  const r = P.resumo(o, 160);
  assert.deepEqual([r.total, r.min, r.media, r.abaixo, r.minCanal], [3, 100, 150, 2, 'ML']);
  assert.deepEqual(P.porMarketplace(o).map(m => m.nome), ['ML', 'Amazon']);
  assert.deepEqual(P.historico(o).map(h => h.min), [150, 100]);
  assert.deepEqual(P.vendedores(o)[0], { nome: 'X', total: 2 });
  assert.match(P.paraCSV(o), /"Produto";"Preço"/);
});
