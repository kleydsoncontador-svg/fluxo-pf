/* Leitores de extrato PDF por banco (SEM IA): Bradesco (app Celular) e Caixa (conta corrente).
   Cada leitor só ACEITA o resultado se o saldo conferir linha a linha; senão devolve null e o leitor genérico tenta.
   Entrada: pages = [{ num, items:[{str,x,y,w}] }]. Saída: { lancamentos:[{data,historico,valor_entrada,valor_saida,documento}], layout, observacao } ou null. */
(function (root) {
  'use strict';
  var NUM = /^\d{1,3}(\.\d{3})*,\d{2}$/;
  var num = function (s) { return parseFloat(String(s).replace(/\./g, '').replace(',', '.')); };
  var iso = function (d) { return d.slice(6, 10) + '-' + d.slice(3, 5) + '-' + d.slice(0, 2); };
  var cent = function (v) { return Math.round(v * 100); };

  // agrupa itens em linhas (mesma altura) e ordena da esquerda para a direita
  function linhas(items) {
    var it = items.slice().sort(function (a, b) { return b.y - a.y || a.x - b.x; }), out = [];
    it.forEach(function (i) { var l = out[out.length - 1]; if (l && Math.abs(l.y - i.y) <= 3) l.its.push(i); else out.push({ y: i.y, its: [i] }); });
    out.forEach(function (l) { l.its.sort(function (a, b) { return a.x - b.x; }); l.txt = l.its.map(function (i) { return i.str.trim(); }).join(' ').replace(/\s+/g, ' ').trim(); });
    return out;
  }

  // ── Bradesco (extrato do app Celular): Data | Histórico (título + complemento) | Docto | Crédito | Débito | Saldo ──
  function bradesco(pages) {
    var all = pages.reduce(function (a, p) { return a.concat(p.items); }, []);
    if (!all.some(function (i) { return /Bradesco/i.test(i.str); })) return null;
    var out = [], rows = [], ok = true, checks = 0, totC = 0, totD = 0, totalLinha = null;
    pages.forEach(function (pg) {
      var hd = {}; pg.items.forEach(function (i) { var t = i.str.trim(); if (/^Cr[eé]dito/.test(t)) hd.c = i.x + i.w; else if (/^D[eé]bito/.test(t)) hd.d = i.x + i.w; else if (/^Saldo/.test(t) && i.y < 700) hd.s = i.x + i.w; else if (/^Docto/.test(t)) hd.doc = i.x; else if (/^Hist[oó]rico/.test(t)) hd.h = i.x; else if (/^Data$/.test(t)) hd.dt = i.x; });
      if (!(hd.c && hd.d && hd.s && hd.doc && hd.h)) return;
      var topo = Math.max.apply(null, pg.items.filter(function (i) { return /^Data$/.test(i.str.trim()); }).map(function (i) { return i.y; }).concat([0]));
      var corpo = pg.items.filter(function (i) { return i.y < topo - 3; });
      var rodape = corpo.filter(function (i) { return /^Total$/.test(i.str.trim()); })[0];
      corpo = corpo.filter(function (i) { return !rodape || i.y > rodape.y + 3; });
      if (rodape) { var tl = pg.items.filter(function (i) { return Math.abs(i.y - rodape.y) <= 3 && NUM.test(i.str.trim()); }); if (tl.length >= 3) totalLinha = tl.map(function (i) { return num(i.str); }); }
      var dts = corpo.filter(function (i) { return /^\d{2}\/\d{2}\/\d{4}$/.test(i.str.trim()) && i.x < hd.h - 10; }).sort(function (a, b) { return b.y - a.y; });
      var docs = corpo.filter(function (i) { return Math.abs(i.x - hd.doc) < 20 && /^\d{3,}$/.test(i.str.trim()); }).sort(function (a, b) { return b.y - a.y; });
      docs.forEach(function (dc) {
        var y = dc.y, bloco = corpo.filter(function (i) { return Math.abs(i.y - y) <= 7 && i.x >= hd.h - 5 && i.x < hd.doc - 5; }).sort(function (a, b) { return b.y - a.y || a.x - b.x; });
        var hist = bloco.map(function (i) { return i.str.trim(); }).filter(Boolean).join(' - ');
        var nums = corpo.filter(function (i) { return Math.abs(i.y - y) <= 3 && NUM.test(i.str.trim()); }), cr = 0, db = 0, sd = null;
        nums.forEach(function (n) { var e = n.x + n.w, dc2 = Math.abs(e - hd.c), dd = Math.abs(e - hd.d), ds = Math.abs(e - hd.s), m = Math.min(dc2, dd, ds); if (m === dc2) cr = num(n.str); else if (m === dd) db = num(n.str); else sd = num(n.str); });
        var dtI = dts.filter(function (d) { return d.y >= y - 5; }).pop(); // a data mais próxima ACIMA (a do dia do bloco)
        if (!dtI || sd == null || (!cr && !db)) { ok = false; return; }
        var d = iso(dtI.str.trim());
        rows.push({ cr: cr, db: db, sd: sd }); totC += cr; totD += db;
        out.push({ data: d, historico: hist, valor_entrada: cr, valor_saida: db, documento: dc.str.trim() });
      });
    });
    if (!out.length || !ok) return null;
    // o PDF não imprime o sinal do saldo quando a conta está no limite (negativo): testa os dois sinais no 1º saldo e exige que TODA a cadeia feche
    var fecha = false;
    [1, -1].forEach(function (s0) {
      if (fecha) return;
      var prev = s0 * rows[0].sd - rows[0].cr + rows[0].db, bom = true;
      rows.forEach(function (r, k) { var alvo = cent(prev + r.cr - r.db); if (k === 0) { prev = s0 * r.sd; return; } if (alvo === cent(r.sd)) prev = r.sd; else if (alvo === -cent(r.sd)) prev = -r.sd; else bom = false; });
      if (bom) fecha = true;
    });
    if (!fecha) return null; checks = rows.length;
    var obs = '✓ conferido: saldo linha a linha (' + checks + ' conferências)';
    if (totalLinha) { if (cent(totC) !== cent(totalLinha[0]) || cent(totD) !== cent(totalLinha[1])) return null; obs += ' e totais do extrato'; }
    return { lancamentos: out, layout: 'Bradesco (app Celular)', observacao: obs + '.' };
  }

  // ── Caixa (extrato por período): Data Mov. | Nr. Doc. | Histórico | Valor D/C | Saldo D/C ──
  function caixa(pages) {
    var all = pages.reduce(function (a, p) { return a.concat(p.items); }, []);
    if (!all.some(function (i) { return /CAIXA/.test(i.str); }) || !all.some(function (i) { return /Extrato por per/i.test(i.str); })) return null;
    var out = [], prev = null, ok = true, checks = 0;
    var re = /^(\d{2}\/\d{2}\/\d{4})\s+(\d{6})\s+(.+?)\s+(\d{1,3}(?:\.\d{3})*,\d{2})\s+([DC])\s+(\d{1,3}(?:\.\d{3})*,\d{2})\s+([DC])$/;
    pages.forEach(function (pg) {
      linhas(pg.items).forEach(function (l) {
        var t = l.txt, a = /^(?:\d{6}\s+)?SALDO ANTERIOR\s+(\d{1,3}(?:\.\d{3})*,\d{2})\s+([DC])/.exec(t);
        if (a && prev == null) { prev = (a[2] === 'D' ? -1 : 1) * num(a[1]); return; }
        var m = re.exec(t); if (!m) return;
        if (/^SALDO DIA/.test(m[3])) return;
        var v = num(m[4]), sd = (m[7] === 'D' ? -1 : 1) * num(m[6]), ent = m[5] === 'C' ? v : 0, sai = m[5] === 'D' ? v : 0;
        if (prev == null) prev = Math.round((sd - ent + sai) * 100) / 100;
        checks++; if (cent(prev + ent - sai) !== cent(sd)) ok = false;
        prev = sd; out.push({ data: iso(m[1]), historico: m[3].trim(), valor_entrada: ent, valor_saida: sai, documento: m[2] === '000000' ? null : m[2] });
      });
    });
    if (!out.length || !ok) return null;
    return { lancamentos: out, layout: 'Caixa (conta corrente)', observacao: '✓ conferido: saldo linha a linha (' + checks + ' conferências).' };
  }

  var API = { parse: function (pages) { var r = null; try { r = bradesco(pages); } catch (e) { r = null; } if (r) return r; try { r = caixa(pages); } catch (e) { r = null; } return r; }, bradesco: bradesco, caixa: caixa };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.ExtratoBancos = API;
})(typeof window !== 'undefined' ? window : this);
