-- FLUXO PF — estrutura do banco (rodar UMA vez no SQL Editor do projeto Supabase "fluxo-pf").
-- Troque __EMAIL_DO_DONO__ pelo e-mail do login antes de rodar. Uma única tabela chave/valor. Só o e-mail do dono lê e grava (RLS). Ninguém sem login enxerga nada.
create table if not exists public.dados_app (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.dados_app enable row level security;

drop policy if exists "dono le"       on public.dados_app;
drop policy if exists "dono insere"   on public.dados_app;
drop policy if exists "dono atualiza" on public.dados_app;
drop policy if exists "dono apaga"    on public.dados_app;

create policy "dono le"       on public.dados_app for select to authenticated using      ((auth.jwt() ->> 'email') = '__EMAIL_DO_DONO__');
create policy "dono insere"   on public.dados_app for insert to authenticated with check ((auth.jwt() ->> 'email') = '__EMAIL_DO_DONO__');
create policy "dono atualiza" on public.dados_app for update to authenticated using      ((auth.jwt() ->> 'email') = '__EMAIL_DO_DONO__') with check ((auth.jwt() ->> 'email') = '__EMAIL_DO_DONO__');
create policy "dono apaga"    on public.dados_app for delete to authenticated using      ((auth.jwt() ->> 'email') = '__EMAIL_DO_DONO__');

revoke all on public.dados_app from anon;
grant select, insert, update, delete on public.dados_app to authenticated;
