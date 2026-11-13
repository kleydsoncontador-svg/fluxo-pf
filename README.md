# Fluxo PF

Controle de fluxo de caixa de pessoa física: contas a pagar e a receber (com recorrência por 5 anos), cartões de crédito com faturas, extrato bancário (importação de PDF) e saldo mês a mês. Visual preto, branco e cinza; funciona no celular e no computador.

- Acesso restrito: só o dono entra (login no Supabase, cadastro público desligado).
- Banco próprio no Supabase (tabela `dados_app`, ver `schema.sql`); a trava de acesso fica no banco (RLS).
- Site estático no GitHub Pages; sem servidor próprio.

Nada de dados fica neste repositório.
