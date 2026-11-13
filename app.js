/* FLUXO PF — casca do app: login, armazenamento no Supabase (tabela dados_app), tema, mês de referência, backup.
   O app só abre com login; o cadastro público de usuários fica DESLIGADO no Supabase e as regras de acesso (RLS) só deixam o e-mail do dono ler/gravar (a trava está no banco, não no código do site). */
(function () {
  'use strict';
  var sb = null, usuario = null, cache = {}, pendentes = 0;

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
      cache[k] = v; pendentes++;
      sb.from('dados_app').upsert({ key: k, value: v, updated_at: new Date().toISOString() }).then(function (r) {
        pendentes--; if (r.error) { console.warn('Fluxo PF: não gravou', k, r.error); window.toast('Não consegui salvar no banco (' + (r.error.message || 'erro') + '). Confira a internet e tente de novo.', 'err'); }
      }, function (e) { pendentes--; console.warn(e); window.toast('Falha de rede ao salvar. Tente de novo.', 'err'); });
    },
    fechAtual: function () { var m = cache['fpf_referencia']; return (typeof m === 'string' && /^\d{4}-\d{2}$/.test(m)) ? m : mesHoje(); },
    chaves: function () { return Object.keys(cache); }
  };
  function mesHoje() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function somaMes(m, n) { var y = +m.slice(0, 4), mm = +m.slice(5, 7) - 1 + n, d = new Date(y, mm, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

  async function carregarTudo() {
    cache = {}; var de = 0;
    for (;;) {
      var r = await sb.from('dados_app').select('key,value').range(de, de + 999);
      if (r.error) throw r.error;
      (r.data || []).forEach(function (x) { cache[x.key] = x.value; });
      if ((r.data || []).length < 1000) break; de += 1000;
    }
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

  // ── backup: baixa tudo em um arquivo / restaura de um arquivo ──
  function baixarBackup() {
    var o = {}; Object.keys(cache).forEach(function (k) { if (/^(kcbm_pf_|fpf_)/.test(k)) o[k] = cache[k]; });
    var blob = new Blob([JSON.stringify({ app: 'fluxo-pf', em: new Date().toISOString(), dados: o }, null, 1)], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'fluxo-pf-backup-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    window.toast('Backup baixado (' + Object.keys(o).length + ' itens).', 'ok');
  }
  function restaurarBackup() {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      var j; try { j = JSON.parse(await f.text()); } catch (e) { window.toast('Esse arquivo não é um backup válido.', 'err'); return; }
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
      c.querySelectorAll('tr').forEach(function (r) { if (!r.textContent.trim()) r.remove(); });
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
      + '<button class="mini" id="btnPdf" title="Imprimir ou salvar esta tela em PDF">PDF</button><button class="mini" id="btnXls" title="Baixar esta tela em Excel">Excel</button>'
      + '<button id="btnBackup" title="Baixar uma cópia de todos os dados">⬇ Backup</button><button id="btnRestaurar" title="Importar dados de um arquivo de backup (ou do módulo antigo do KCBM)">⬆ Importar</button><button id="btnTema" title="Claro / escuro">◐</button><button id="btnSair">Sair</button></div>';
    document.getElementById('btnPdf').onclick = function () { exportarTela('pdf'); }; document.getElementById('btnXls').onclick = function () { exportarTela('xls'); };
    document.getElementById('btnTema').onclick = alternarTema; document.getElementById('btnBackup').onclick = baixarBackup; document.getElementById('btnRestaurar').onclick = restaurarBackup;
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
  document.addEventListener('visibilitychange', function () { if (!document.hidden) sincronizar(); });
  window.addEventListener('focus', sincronizar);
  setInterval(sincronizar, 20000);
  async function abrirApp(user) {
    usuario = user;
    document.getElementById('tela-login').style.display = 'none'; document.getElementById('tela-app').style.display = 'block';
    document.getElementById('pf-app').innerHTML = '<div style="padding:40px;text-align:center;color:var(--slate)">Carregando seus dados…</div>';
    try { await carregarTudo(); } catch (e) { console.warn(e); document.getElementById('pf-app').innerHTML = '<div style="padding:40px;text-align:center;color:var(--neg)">Não consegui carregar os dados (' + (e.message || e) + '). Recarregue a página.</div>'; return; }
    desenharTopo(); window.pfRender();
  }
  function mostrarLogin(msg) { document.getElementById('tela-app').style.display = 'none'; document.getElementById('tela-login').style.display = 'flex'; cache = {}; if (msg) document.getElementById('loginErro').textContent = msg; }

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
