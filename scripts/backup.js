// Backup do banco do Fluxo PF (tabela dados_app) para o repositório PRIVADO de backups.
// Roda no GitHub Actions a cada 6 h. Usa a chave "service role" (segredo SUPABASE_SERVICE_ROLE_KEY) porque o banco só deixa o dono ler.
const fs = require('fs'), path = require('path');
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY, DEST = process.env.BACKUP_DEST_DIR;
if (!URL || !KEY || !DEST) { console.error('Faltam SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou BACKUP_DEST_DIR.'); process.exit(1); }
(async () => {
  const linhas = []; let de = 0;
  for (;;) {
    const r = await fetch(URL + '/rest/v1/dados_app?select=key,value,updated_at&order=key.asc', { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, Range: de + '-' + (de + 999) } });
    if (!r.ok) { console.error('Erro ' + r.status + ': ' + (await r.text()).slice(0, 300)); process.exit(1); }
    const lote = await r.json(); linhas.push(...lote); if (lote.length < 1000) break; de += 1000;
  }
  const dados = linhas.filter(x => /^(kcbm_pf_|fpf_)/.test(x.key));   // o que o app importa; as cópias "bkp_" ficam de fora
  const pessoas = dados.filter(x => /^kcbm_pf_[a-z0-9]{6,}$/.test(x.key) && x.value && typeof x.value === 'object');
  const conteudo = pessoas.reduce((a, x) => a + ['extrato', 'pagar', 'receber', 'cartoes', 'entradas', 'gastos', 'contratos'].reduce((b, c) => b + (Array.isArray(x.value[c]) ? x.value[c].length : 0), 0), 0);
  // trava: se o banco veio vazio/zerado, NÃO grava por cima de um backup bom (e avisa com erro para você ver no GitHub)
  const ult = path.join(DEST, 'ULTIMO.json'); let antes = 0;
  try { const u = JSON.parse(fs.readFileSync(ult, 'utf8')); antes = u.itens || 0; } catch (e) {}
  if (antes > 20 && conteudo < antes * 0.5) { console.error('ALERTA: o banco tem muito menos itens (' + conteudo + ') que o último backup (' + antes + '). Backup NÃO sobrescrito.'); process.exit(1); }
  const agora = new Date(), p2 = n => String(n).padStart(2, '0'), mes = agora.getUTCFullYear() + '-' + p2(agora.getUTCMonth() + 1);
  const nome = 'backup_' + mes + '-' + p2(agora.getUTCDate()) + '_' + p2(agora.getUTCHours()) + 'h.json';
  const obj = { app: 'fluxo-pf', em: agora.toISOString(), itens: conteudo, dados: Object.fromEntries(dados.map(x => [x.key, x.value])) };   // mesmo formato do botão Backup/Importar
  fs.mkdirSync(path.join(DEST, mes), { recursive: true });
  fs.writeFileSync(path.join(DEST, mes, nome), JSON.stringify(obj, null, 1)); fs.writeFileSync(ult, JSON.stringify(obj, null, 1));
  console.log('Backup gravado: ' + mes + '/' + nome + ' — ' + dados.length + ' chaves, ' + conteudo + ' itens.');
})().catch(e => { console.error(e); process.exit(1); });
