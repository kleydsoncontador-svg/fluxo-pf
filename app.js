/* FLUXO PF — casca do app: login, armazenamento no Supabase (tabela dados_app), tema, mês de referência, backup.
   O app só abre com login; o cadastro público de usuários fica DESLIGADO no Supabase e as regras de acesso (RLS) só deixam o e-mail do dono ler/gravar (a trava está no banco, não no código do site). */
(function () {
  'use strict';
  var sb = null, usuario = null, cache = {}, pendentes = 0, carregado = false, stamps = {}, filas = {}, geracao = 0;

  // ── aviso na tela (o módulo usa toast(msg, tipo)) ──
  var tt = null;
  window.toast = function (msg, tipo) {
    var el = document.getElementById('toast'); if (!el) return;
    el.className = tipo || ''; el.textContent = msg; el.style.display = 'block'; clearTimeout(tt); tt = setTimeout(function () { el.style.display = 'none'; }, tipo === 'err' ? 6000 : 3200);
  };

  // ── armazenamento: mesmo contrato do módulo (S.g / S.s). Nunca grava null (a coluna value é NOT NULL). ──
  window.S = {
    g: function (k) { return (k in cache) ? cache[k] : null; },
    s: function (k, v) {
      if (v == null) v = {};
      if (!carregado) { window.toast('Os dados ainda não carregaram — não salvei nada para não apagar o que existe.', 'err'); return; }
      // trava anti-apagão: nunca deixa um cadastro cheio virar vazio de uma vez
      var vel = cache[k];
      if (/^kcbm_pf_/.test(k) && vel && typeof vel === 'object' && !Array.isArray(vel)) {
        var CH = ['extrato', 'bancos', 'pagar', 'receber', 'cartoes', 'entradas', 'gastos'], tem = function (o) { return CH.some(function (c) { return Array.isArray(o[c]) && o[c].length; }); };
        if (tem(vel) && !tem(v)) { window.toast('Bloqueei uma gravação que apagaria todos os dados. Recarregue a página.', 'err'); return; }
        // cópia diária do estado anterior (rede de segurança): bkp_AAAA-MM-DD_<chave>
        if (tem(vel)) { var bk = 'bkp_' + new Date().toISOString().slice(0, 10) + '_' + k; if (!(bk in cache)) { cache[bk] = vel; sb.from('dados_app').upsert({ key: bk, value: vel, updated_at: new Date().toISOString() }).then(function () {}, function () {}); } }
      }
      cache[k] = v; pendentes++; var ger = geracao;
      filas[k] = (filas[k] || Promise.resolve()).then(function () { return gravar(k, v, ger); }).catch(function (e) { console.warn(e); window.toast('Falha de rede ao salvar. Tente de novo.', 'err'); }).then(function () { pendentes--; agendarPasta(); });
    },
    fechAtual: function () { var m = cache['fpf_referencia']; return (typeof m === 'string' && /^\d{4}-\d{2}$/.test(m)) ? m : mesHoje(); },
    chaves: function () { return Object.keys(cache); }
  };
  function mesHoje() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function somaMes(m, n) { var y = +m.slice(0, 4), mm = +m.slice(5, 7) - 1 + n, d = new Date(y, mm, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

  // Gravação com trava de versão: só grava se ninguém (outro aparelho) mudou o mesmo item desde que este aparelho o leu.
  // Se mudou, NÃO sobrescreve: recarrega a versão mais nova e avisa. Assim um celular/aba desatualizado nunca apaga o que foi feito em outro lugar.
  async function gravar(k, v, ger) {
    if (ger !== geracao) return; // houve conflito depois deste pedido: descarta (estava baseado em dados velhos)
    var agora = new Date().toISOString(), st = stamps[k], r;
    if (st) {
      r = await sb.from('dados_app').update({ value: v, updated_at: agora }).eq('key', k).eq('updated_at', st).select('updated_at');
      if (r.error) { window.toast('Não consegui salvar no banco (' + (r.error.message || 'erro') + '). Confira a internet e tente de novo.', 'err'); return; }
      if (!r.data || !r.data.length) { await conflito(); return; }
      stamps[k] = r.data[0].updated_at;
    } else {
      r = await sb.from('dados_app').insert({ key: k, value: v, updated_at: agora }).select('updated_at');
      if (r.error) { if (r.error.code === '23505') { await conflito(); return; } window.toast('Não consegui salvar no banco (' + (r.error.message || 'erro') + ').', 'err'); return; }
      stamps[k] = (r.data && r.data[0]) ? r.data[0].updated_at : agora;
    }
  }
  async function conflito() {
    geracao++;
    window.toast('Outro aparelho alterou estes dados antes de você. Carreguei a versão mais nova — refaça a última alteração.', 'err');
    try { await carregarTudo(true); desenharTopo(); window.pfRender && window.pfRender(); } catch (e) { console.warn(e); }
  }

  async function carregarTudo(forcar) {
    var novo = {}, nst = {}, de = 0; // carrega num objeto à parte e só troca no fim: nunca deixa o app ver dados pela metade
    for (;;) {
      var r = await sb.from('dados_app').select('key,value,updated_at').range(de, de + 999);
      if (r.error) throw r.error;
      (r.data || []).forEach(function (x) { novo[x.key] = x.value; nst[x.key] = x.updated_at; });
      if ((r.data || []).length < 1000) break; de += 1000;
    }
    if (carregado && pendentes > 0 && !forcar) return; // o usuário salvou algo durante a busca: não troca a memória por uma versão que ainda não tem a alteração
    cache = novo; stamps = nst; carregado = true;
  }

  // ── leitor de extrato em PDF (mesmo leitor genérico do KCBM: só aceita se o saldo conferir) ──
  window._lancctbParsearExtratoGenerico = async function (pdf) {
    if (!window.ExtratoGenerico && !window.ExtratoBancos) return null;
    var paginas = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      var c = await (await pdf.getPage(p)).getTextContent();
      paginas.push({ num: p, items: c.items.filter(function (i) { return i.str && i.str.trim(); }).map(function (i) { return { str: i.str, x: i.transform[4], y: i.transform[5], w: i.width }; }) });
    }
    if (window.ExtratoBancos) { var rb = window.ExtratoBancos.parse(paginas); if (rb) return { lancamentos: rb.lancamentos, saldoAnteriorDoc: null, saldoFinalDoc: null, layout: rb.layout, observacao: rb.observacao }; }
    if (!window.ExtratoGenerico) return null;
    var r = null; try { r = window.ExtratoGenerico.parse(paginas); } catch (e) { console.warn('extrato genérico', e); return null; }
    if (!r || !r.lancamentos.length || !r.confere) return null;
    var cx = r.confereTotais && r.confereTotais.ok ? r.confereTotais.modo : null;
    return { lancamentos: r.lancamentos, saldoAnteriorDoc: null, saldoFinalDoc: null, layout: 'Genérico (colunas detectadas' + (r.invertido ? ', ordem inversa' : '') + ')', observacao: '✓ conferido: ' + (r.checagens >= 3 && r.acertos === r.checagens ? 'saldo linha a linha (' + r.acertos + ' conferências)' : cx) + '.' };
  };

  // ── tema claro/escuro ──
  function aplicarTema(t) { if (t) document.documentElement.setAttribute('data-tema', t); else document.documentElement.removeAttribute('data-tema'); }
  try { aplicarTema(localStorage.getItem('fpf_tema')); } catch (e) {}
  function alternarTema() {
    var atual = document.documentElement.getAttribute('data-tema') || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro');
    var novo = atual === 'escuro' ? 'claro' : 'escuro'; aplicarTema(novo); try { localStorage.setItem('fpf_tema', novo); } catch (e) {}
  }

  // ── diagnóstico: lê direto do banco e mostra o que existe (só leitura) ──
  async function diagnostico() {
    var r = await sb.from('dados_app').select('key,value,updated_at');
    var box = document.createElement('div'); box.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:20px';
    var h = '<div style="background:#fff;color:#111;border-radius:12px;max-width:900px;width:100%;max-height:90vh;overflow:auto;padding:18px;font-size:13px"><div style="display:flex;justify-content:space-between;margin-bottom:10px"><b style="font-size:16px">O que está guardado no banco</b><button id="diagFecha">Fechar</button></div>';
    if (r.error) h += '<p style="color:#b00">Erro: ' + (r.error.message || r.error) + '</p>';
    else { h += '<table style="width:100%;border-collapse:collapse"><tr style="text-align:left"><th>Chave</th><th>Tamanho</th><th>Conteúdo</th><th>Atualizado</th></tr>';
      (r.data || []).sort(function (a, b) { return a.key < b.key ? -1 : 1; }).forEach(function (x) {
        var v = x.value, c = []; if (v && typeof v === 'object') { if (Array.isArray(v)) c.push(v.length + ' itens'); else Object.keys(v).forEach(function (k) { if (Array.isArray(v[k])) c.push(k + ': ' + v[k].length); }); } else c.push(String(v).slice(0, 40));
        h += '<tr style="border-top:1px solid #ddd;vertical-align:top"><td style="padding:4px 6px;word-break:break-all">' + x.key + '</td><td style="padding:4px 6px">' + JSON.stringify(v).length + ' B</td><td style="padding:4px 6px">' + (c.join(' · ') || '—') + '</td><td style="padding:4px 6px">' + String(x.updated_at || '').replace('T', ' ').slice(0, 19) + '</td></tr>'; });
      h += '</table>'; }
    box.innerHTML = h + '</div>'; document.body.appendChild(box); box.querySelector('#diagFecha').onclick = function () { box.remove(); };
  }
  // ── backup: baixa tudo em um arquivo / restaura de um arquivo ──
  function baixarBackup(auto) {
    var o = dadosParaBackup();
    var blob = new Blob([JSON.stringify({ app: 'fluxo-pf', em: new Date().toISOString(), dados: o }, null, 1)], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); var _d = new Date(), _p = function (n) { return String(n).padStart(2, '0'); }; a.download = 'fluxo-pf-backup-' + _d.getFullYear() + '-' + _p(_d.getMonth() + 1) + '-' + _p(_d.getDate()) + (auto === true ? '-' + _p(_d.getHours()) + _p(_d.getMinutes()) : '') + '.json'; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    window.toast((auto === true ? 'Backup diário salvo na pasta Downloads (' : 'Backup baixado (') + Object.keys(o).length + ' itens).', 'ok');
  }
  // backup automático no aparelho: baixa um arquivo sozinho quando o app abre e os dados MUDARAM desde o último backup, com pelo menos 4 h de intervalo e no máximo 3 por dia (data local)
  function dadosParaBackup() { var o = {}; Object.keys(cache).forEach(function (k) { if (/^(kcbm_pf_|fpf_)/.test(k)) o[k] = cache[k]; }); return o; }
  function hashTexto(t) { var h = 5381; for (var i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return String(h) + ':' + t.length; }
  function backupDiario() {
    try {
      if (window.matchMedia && matchMedia('(max-width:720px)').matches) return;   // no celular não baixa arquivo de backup sozinho: os dados já sincronizam com o computador pelo servidor
      var tem = Object.keys(cache).some(function (k) { var v = cache[k]; return /^kcbm_pf_[a-z0-9]{6,}/.test(k) && v && ['extrato', 'pagar', 'receber', 'cartoes', 'entradas', 'gastos', 'contratos'].some(function (c) { return Array.isArray(v[c]) && v[c].length; }); });
      if (!tem) return;
      var ag = new Date(), dia = ag.getFullYear() + '-' + String(ag.getMonth() + 1).padStart(2, '0') + '-' + String(ag.getDate()).padStart(2, '0');
      var ult = {}; try { ult = JSON.parse(localStorage.getItem('fpf_bkp_ult') || '{}'); } catch (e) {}
      var h = hashTexto(JSON.stringify(dadosParaBackup()));
      if (ult.h === h) return;                                             // nada mudou desde o último backup
      if (ult.t && ag.getTime() - ult.t < 4 * 3600 * 1000) return;         // no mínimo 4 h entre backups
      var n = (ult.dia === dia) ? (ult.n || 0) : 0; if (n >= 3) return;     // no máximo 3 por dia
      pastaLer().then(function (hd) { return hd ? pastaPermissao(hd, false) : false; }).then(function (ok) { if (!ok) baixarBackup(true); }, function () { baixarBackup(true); });   // com pasta escolhida, não baixa para Downloads
      localStorage.setItem('fpf_bkp_ult', JSON.stringify({ t: ag.getTime(), h: h, dia: dia, n: n + 1 }));
    } catch (e) { console.warn('backupDiario', e); }
  }
  // ── backup AUTOMÁTICO em uma pasta do computador (sem janela de download) ──
  // Você escolhe a pasta uma vez (ex.: dentro do OneDrive). Depois o app grava sozinho um arquivo novo sempre que os dados mudam
  // (no máximo 1 a cada 15 min), mais o "ULTIMO" sempre atualizado, e guarda os 40 mais recentes. Só funciona no Chrome/Edge do computador.
  var PASTA_DB = 'fluxo-pf-pasta', pastaTimer = null, pastaGravando = false;
  function idb(fn) { return new Promise(function (res, rej) { var r = indexedDB.open(PASTA_DB, 1); r.onupgradeneeded = function () { r.result.createObjectStore('h'); }; r.onerror = function () { rej(r.error); }; r.onsuccess = function () { var tx = r.result.transaction('h', 'readwrite'), st = tx.objectStore('h'), q = fn(st); tx.oncomplete = function () { res(q && q.result); }; tx.onerror = function () { rej(tx.error); }; }; }); }
  function pastaLer() { return idb(function (st) { return st.get('pasta'); }).catch(function () { return null; }); }
  function pastaGravarHandle(h) { return idb(function (st) { st.put(h, 'pasta'); }); }
  async function pastaPermissao(h, pedir) { if (!h) return false; try { var o = { mode: 'readwrite' }; if ((await h.queryPermission(o)) === 'granted') return true; if (pedir && (await h.requestPermission(o)) === 'granted') return true; } catch (e) { console.warn('permissão da pasta', e); } return false; }
  async function salvarBackupNaPasta(forcar) {
    if (pastaGravando || !carregado) return false;
    try {
      var h = await pastaLer(); if (!h || !(await pastaPermissao(h, false))) return false;
      var tem = Object.keys(cache).some(function (k) { var v = cache[k]; return /^kcbm_pf_[a-z0-9]{6,}/.test(k) && v && ['extrato', 'pagar', 'receber', 'cartoes', 'entradas', 'gastos', 'contratos'].some(function (c) { return Array.isArray(v[c]) && v[c].length; }); });
      if (!tem) return false;
      var txt = JSON.stringify({ app: 'fluxo-pf', em: new Date().toISOString(), dados: dadosParaBackup() }, null, 1), hash = hashTexto(JSON.stringify(dadosParaBackup()));
      var ult = {}; try { ult = JSON.parse(localStorage.getItem('fpf_pasta_ult') || '{}'); } catch (e) {}
      if (!forcar && ult.h === hash) return false;                                        // nada mudou
      if (!forcar && ult.t && Date.now() - ult.t < 15 * 60 * 1000) { agendarPasta(); return false; }  // no máximo 1 a cada 15 min
      pastaGravando = true;
      var d = new Date(), p2 = function (n) { return String(n).padStart(2, '0'); }, nome = 'fluxo-pf-backup-' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + '.json';
      for (var arq of [nome, 'fluxo-pf-backup-ULTIMO.json']) { var fh = await h.getFileHandle(arq, { create: true }), w = await fh.createWritable(); await w.write(txt); await w.close(); }
      var nomes = []; for await (var e of h.values()) { if (e.kind === 'file' && /^fluxo-pf-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(e.name)) nomes.push(e.name); }
      nomes.sort().reverse().slice(40).forEach(function (n) { h.removeEntry(n).catch(function () {}); });
      localStorage.setItem('fpf_pasta_ult', JSON.stringify({ t: Date.now(), h: hash, nome: nome, quando: d.toISOString() })); pastaGravando = false; atualizarBotaoPasta();
      return nome;
    } catch (e) { pastaGravando = false; console.warn('backup na pasta', e); return false; }
  }
  function agendarPasta() { clearTimeout(pastaTimer); pastaTimer = setTimeout(function () { salvarBackupNaPasta(false); }, 90 * 1000); }
  async function botaoPasta() {
    if (!window.showDirectoryPicker) { window.toast('Este navegador não deixa escolher uma pasta. Use o Chrome ou o Edge no computador.', 'err'); return; }
    var h = await pastaLer();
    if (h) {
      if (!(await pastaPermissao(h, true))) { window.toast('Sem permissão para a pasta. Escolha a pasta de novo.', 'err'); h = null; }
      else { var u = {}; try { u = JSON.parse(localStorage.getItem('fpf_pasta_ult') || '{}'); } catch (e) {}
        if (!confirm('Backup automático ATIVO na pasta "' + h.name + '".\
' + (u.quando ? 'Último: ' + new Date(u.quando).toLocaleString('pt-BR') + '\
' : '') + '\
OK = salvar um backup agora.\
Cancelar = trocar a pasta.')) { h = null; } else { var n = await salvarBackupNaPasta(true); window.toast(n ? 'Backup salvo na pasta: ' + n : 'Não consegui salvar agora.', n ? 'ok' : 'err'); return; } }
    }
    try { var novo = await window.showDirectoryPicker({ mode: 'readwrite', id: 'fluxo-pf-backup', startIn: 'documents' }); await pastaGravarHandle(novo); var n2 = await salvarBackupNaPasta(true); window.toast(n2 ? 'Pasta definida. Backup salvo: ' + n2 : 'Pasta definida.', 'ok'); }
    catch (e) { if (e && e.name !== 'AbortError') window.toast('Não consegui usar essa pasta: ' + (e.message || e) + '. Escolha outra (ex.: Documentos ou OneDrive).', 'err'); }
    atualizarBotaoPasta();
  }
  async function atualizarBotaoPasta() {
    var b = document.getElementById('btnPasta'); if (!b) return; var h = await pastaLer(), ok = h ? await pastaPermissao(h, false) : false;
    b.textContent = ok ? '📁 Auto ✓' : (h ? '📁 Reautorizar' : '📁 Pasta'); b.title = ok ? 'Backup automático ativo na pasta "' + h.name + '". Clique para salvar agora ou trocar a pasta.' : (h ? 'Clique para reautorizar a pasta de backup (o navegador pede de novo às vezes).' : 'Escolha uma pasta do computador (ex.: no OneDrive) para o backup automático.');
  }
  function restaurarBackup() {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      var j; try { j = JSON.parse(await f.text()); } catch (e) { window.toast('Esse arquivo não é um backup válido.', 'err'); return; }
      if (j && j.app === 'fluxo-pf-adicionar-cartoes' && Array.isArray(j.cartoes)) { // acrescenta cartões na 1ª pessoa, sem apagar nada
        var lista = window.S.g('kcbm_pf_lista') || [], pid = lista[0] && lista[0].id; if (!pid) { window.toast('Cadastre a pessoa antes.', 'err'); return; }
        var dp = JSON.parse(JSON.stringify(window.S.g('kcbm_pf_' + pid) || {})); dp.cartoes = Array.isArray(dp.cartoes) ? dp.cartoes : [];
        var tem = dp.cartoes.map(function (c) { return String(c.nome || '').toLowerCase().trim(); }), novos = j.cartoes.filter(function (c) { return tem.indexOf(String(c.nome || '').toLowerCase().trim()) < 0; });
        if (!novos.length) { window.toast('Esses cartões já existem. Nada foi adicionado.', 'ok'); return; }
        if (!confirm('Adicionar ' + novos.length + ' cartão(ões) novo(s)?\n\n' + novos.map(function (c) { return '• ' + c.nome; }).join('\n') + '\n\nNada do que você já tem será alterado.')) return;
        dp.cartoes = dp.cartoes.concat(novos); window.S.s('kcbm_pf_' + pid, dp);
        setTimeout(function () { window.pfRender && window.pfRender(); }, 400); window.toast(novos.length + ' cartão(ões) adicionado(s).', 'ok'); return;
      }
      var d = j && j.dados; if (!d || typeof d !== 'object') { window.toast('Esse arquivo não tem dados do Fluxo PF/KCBM.', 'err'); return; }
      var ks = Object.keys(d).filter(function (k) { return /^(kcbm_pf_|fpf_)/.test(k); });
      if (!ks.length) { window.toast('Nada para importar nesse arquivo.', 'err'); return; }
      if (!confirm('Importar ' + ks.length + ' item(ns) do arquivo? O que já existir com o mesmo nome será SUBSTITUÍDO.\n\nDica: baixe um backup antes.')) return;
      ks.forEach(function (k) { window.S.s(k, d[k]); });
      setTimeout(function () { window.pfRender && window.pfRender(); }, 400); window.toast('Importado: ' + ks.length + ' item(ns).', 'ok');
    };
    inp.click();
  }


  // ── exportar a tela atual: pega as tabelas visíveis (sem botões) e gera Excel (.xls em HTML) ou abre a impressão (salvar como PDF) ──
  function tabelasDaTela() {
    var root = document.getElementById('pf-app'), out = [];
    root.querySelectorAll('table').forEach(function (t) {
      if (t.closest('#pf-modal,[id^="kpf"]') && !t.closest('#kpfAba')) return; if (t.parentElement.closest('table')) return;
      var c = t.cloneNode(true); c.querySelectorAll('button,input,select,svg,script').forEach(function (n) { n.remove(); });
      c.querySelectorAll('tr').forEach(function (r) { if (!r.textContent.trim() || r.style.display === 'none') r.remove(); });
      var tit = ''; var el = t.previousElementSibling; while (el && !tit) { tit = (el.textContent || '').trim(); el = el.previousElementSibling; } if (tit.length > 90) tit = tit.slice(0, 90) + '…';
      out.push({ tit: tit, html: c.outerHTML });
    });
    return out;
  }
  function exportarTela(tipo) {
    var tabs = tabelasDaTela(); if (!tabs.length) { window.toast('Não há tabela nesta tela para exportar.', 'err'); return; }
    var ab = document.querySelector('#pf-app button[style*="3px solid"]'), pessoa = (document.querySelector('#pf-app [style*="1.25rem"]') || {}).textContent || '', ref = window.S.fechAtual();
    var titulo = 'Fluxo PF — ' + (pessoa.trim() ? pessoa.trim() + ' — ' : '') + (ab ? ab.textContent.trim() + ' — ' : '') + ref.slice(5, 7) + '/' + ref.slice(0, 4);
    var css = 'body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111}h1{font-size:16px;margin:0 0 4px}h2{font-size:13px;margin:14px 0 4px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:4px 6px;text-align:left}th{background:#e5e5e5}.s{font-size:10px;color:#555;margin-bottom:8px}';
    var corpo = '<h1>' + titulo + '</h1><div class="s">Gerado em ' + new Date().toLocaleString('pt-BR') + '</div>' + tabs.map(function (x) { return (x.tit ? '<h2>' + x.tit.replace(/</g, '&lt;') + '</h2>' : '') + x.html; }).join('');
    var doc = '<!doctype html><html><head><meta charset="utf-8"><title>' + titulo + '</title><style>' + css + '</style></head><body>' + corpo + '</body></html>';
    if (tipo === 'xls') {
      var blob = new Blob(['﻿', doc], { type: 'application/vnd.ms-excel;charset=utf-8' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'fluxo-pf-' + new Date().toISOString().slice(0, 10) + '.xls'; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500); window.toast('Excel baixado.', 'ok');
    } else {
      var w = window.open('', '_blank'); if (!w) { window.toast('O navegador bloqueou a janela. Permita pop-ups para este site.', 'err'); return; }
      w.document.open(); w.document.write(doc.replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script></body>')); w.document.close();
    }
  }
  // ── tela do app ──
  function desenharTopo() {
    var ref = window.S.fechAtual();
    document.getElementById('topo').innerHTML = '<div class="marca"><i></i>FLUXO PF</div><div class="fim">'
      + '<div class="ref" title="Mês de referência: o saldo e a projeção começam por ele"><button id="refAnt" aria-label="Mês anterior">‹</button><b>' + ref.slice(5, 7) + '/' + ref.slice(0, 4) + '</b><button id="refProx" aria-label="Próximo mês">›</button></div>'
      + '<button id="btnMenu" class="soCel" aria-label="Menu">⋯</button><div class="menuTopo" id="menuTopo"><button class="mini" id="btnPdf" title="Imprimir ou salvar esta tela em PDF">PDF</button><button class="mini" id="btnXls" title="Baixar esta tela em Excel">Excel</button><button class="mini" id="btnDiag" title="Mostra o que está guardado no banco">Dados</button>'
      + '<button id="btnPasta" title="Backup automático em uma pasta">📁 Pasta</button><button id="btnBackup" title="Baixar uma cópia de todos os dados">⬇ Backup</button><button id="btnRestaurar" title="Importar dados de um arquivo de backup (ou do módulo antigo do KCBM)">⬆ Importar</button><button id="btnTema" title="Claro / escuro">◐</button><button id="btnSair">Sair</button></div></div>';
    document.getElementById('btnMenu').onclick = function (ev) { ev.stopPropagation(); document.getElementById('menuTopo').classList.toggle('aberto'); };
    document.getElementById('menuTopo').onclick = function () { this.classList.remove('aberto'); };
    document.getElementById('btnPdf').onclick = function () { exportarTela('pdf'); }; document.getElementById('btnXls').onclick = function () { exportarTela('xls'); }; document.getElementById('btnDiag').onclick = diagnostico; document.getElementById('btnPasta').onclick = botaoPasta; atualizarBotaoPasta();
    document.getElementById('btnTema').onclick = alternarTema; document.getElementById('btnBackup').onclick = function () { baixarBackup(); }; document.getElementById('btnRestaurar').onclick = restaurarBackup;
    document.getElementById('btnSair').onclick = function () { sb.auth.signOut(); };
    var troca = function (n) { window.S.s('fpf_referencia', somaMes(window.S.fechAtual(), n)); desenharTopo(); window.pfRender && window.pfRender(); };
    document.getElementById('refAnt').onclick = function () { troca(-1); }; document.getElementById('refProx').onclick = function () { troca(1); };
  }
  // ── sincronização entre aparelhos: ao voltar para o app e a cada 20 s, busca no banco o que foi digitado em outro aparelho (só redesenha se mudou e se você não está no meio de uma edição) ──
  var sincronizando = false;
  async function sincronizar() {
    if (sincronizando || !usuario || pendentes > 0 || document.hidden) return;
    if (document.querySelector('div[style*="z-index:99999"]')) return;
    var ae = document.activeElement; if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    sincronizando = true;
    try {
      var antes = JSON.stringify(cache), velho = cache;
      await carregarTudo();
      if (JSON.stringify(cache) === antes) { cache = velho; } else { desenharTopo(); window.pfRender && window.pfRender(); }
    } catch (e) { console.warn('sincronizar', e); } finally { sincronizando = false; }
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) sincronizar(); else salvarBackupNaPasta(false); });
  window.addEventListener('focus', sincronizar);
  setInterval(sincronizar, 20000);
  async function abrirApp(user) {
    usuario = user;
    document.getElementById('tela-login').style.display = 'none'; document.getElementById('tela-app').style.display = 'block';
    document.getElementById('pf-app').innerHTML = '<div style="padding:40px;text-align:center;color:var(--slate)">Carregando seus dados…</div>';
    try { await carregarTudo(); } catch (e) { console.warn(e); document.getElementById('pf-app').innerHTML = '<div style="padding:40px;text-align:center;color:var(--neg)">Não consegui carregar os dados (' + (e.message || e) + '). Recarregue a página.</div>'; return; }
    desenharTopo(); window.pfRender(); setTimeout(backupDiario, 1500); setTimeout(function () { salvarBackupNaPasta(false); }, 4000);
  }
  function mostrarLogin(msg) { document.getElementById('tela-app').style.display = 'none'; document.getElementById('tela-login').style.display = 'flex'; cache = {}; carregado = false; if (msg) document.getElementById('loginErro').textContent = msg; }

  function ligarLogin() {
    var form = document.getElementById('formLogin'), erro = document.getElementById('loginErro');
    form.onsubmit = async function (ev) {
      ev.preventDefault(); erro.textContent = '';
      var email = document.getElementById('lgEmail').value.trim(), senha = document.getElementById('lgSenha').value;
      var r = await sb.auth.signInWithPassword({ email: email, password: senha });
      if (r.error) erro.textContent = 'E-mail ou senha incorretos.';
    };
    document.getElementById('lgLink').onclick = async function () {
      erro.textContent = ''; var email = document.getElementById('lgEmail').value.trim(); if (!email) { erro.textContent = 'Digite o e-mail primeiro.'; return; }
      var r = await sb.auth.signInWithOtp({ email: email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
      erro.style.color = r.error ? '#B91C1C' : '#15803D'; erro.textContent = r.error ? 'Não foi possível enviar o link (' + r.error.message + ').' : 'Link enviado. Abra o e-mail e clique nele.';
    };
    document.getElementById('lgEsqueci').onclick = async function () {
      erro.textContent = ''; var email = document.getElementById('lgEmail').value.trim(); if (!email) { erro.textContent = 'Digite o e-mail primeiro.'; return; }
      var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      erro.style.color = r.error ? '#B91C1C' : '#15803D'; erro.textContent = r.error ? 'Não foi possível enviar (' + r.error.message + ').' : 'Se esse e-mail tiver acesso, chegou um link para criar a senha.';
    };
  }

  async function iniciar() {
    if (typeof supabase === 'undefined' || typeof SUPABASE_URL === 'undefined') { document.body.innerHTML = '<p style="padding:30px;font-family:sans-serif">Não consegui carregar o Supabase. Recarregue a página.</p>'; return; }
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    ligarLogin();
    if (window.pdfjsLib) { try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; } catch (e) {} }
    sb.auth.onAuthStateChange(function (ev, session) {
      if (ev === 'SIGNED_OUT') mostrarLogin();
      else if ((ev === 'SIGNED_IN' || ev === 'INITIAL_SESSION') && session && session.user && !usuario) abrirApp(session.user);
      else if (ev === 'PASSWORD_RECOVERY') { var nova = prompt('Digite a NOVA senha (mínimo 8 caracteres):'); if (nova && nova.length >= 8) sb.auth.updateUser({ password: nova }).then(function (r) { window.toast(r.error ? 'Não consegui trocar a senha.' : 'Senha criada. Pode entrar.', r.error ? 'err' : 'ok'); }); }
    });
    var s = await sb.auth.getSession(); if (!s.data.session) mostrarLogin();
    window.addEventListener('beforeunload', function (e) { if (pendentes > 0) { e.preventDefault(); e.returnValue = ''; } });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  document.addEventListener('DOMContentLoaded', iniciar);
})();
