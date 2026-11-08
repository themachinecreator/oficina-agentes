-- Oficina de agentes: pegá todo esto en Supabase → SQL Editor → Run.

create table if not exists agentes (
  id text primary key,
  nombre text not null,
  cargo text not null,
  estado text not null default 'idle' check (estado in ('ok','wait','idle')),
  ahora text not null default '',
  activo boolean not null default false,
  actualizado timestamptz not null default now()
);

create table if not exists tareas (
  id bigint generated always as identity primary key,
  agente text not null references agentes(id),
  descripcion text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente','en_curso','hecha','cancelada')),
  origen text not null default 'beltran',
  creada timestamptz not null default now(),
  actualizada timestamptz not null default now()
);
create index if not exists tareas_agente_idx on tareas (agente, creada desc);

create table if not exists mensajes (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  rol text not null check (rol in ('user','assistant')),
  contenido text not null,
  update_id bigint unique,
  creado timestamptz not null default now()
);
create index if not exists mensajes_chat_idx on mensajes (chat_id, creado desc);

create table if not exists aprobaciones (
  id bigint generated always as identity primary key,
  agente text not null references agentes(id),
  texto text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente','aprobada','rechazada')),
  creada timestamptz not null default now(),
  resuelta timestamptz
);
create index if not exists aprobaciones_agente_idx on aprobaciones (agente);

-- Solo el servidor (con la clave secreta) accede a estas tablas.
alter table agentes enable row level security;
alter table tareas enable row level security;
alter table mensajes enable row level security;
alter table aprobaciones enable row level security;

insert into agentes (id, nombre, cargo, estado, ahora, activo) values
  ('arthur',   'Arthur Whitmore',    'Jefe de oficina',               'ok',   'Atento a tus mensajes en Telegram.', true),
  ('eleanor',  'Eleanor Vance',      'Secretaria personal',           'idle', 'Todavía no está conectada.', false),
  ('margaret', 'Margaret Ellsworth', 'Recepcionista · beltranrelojes','idle', 'Todavía no está conectada.', false),
  ('julian',   'Julian Hart',        'Creador de contenido',          'idle', 'Todavía no está conectado.', false),
  ('theo',     'Theo Lang',          'Editor de video',               'idle', 'Todavía no está conectado.', false),
  ('charles',  'Charles Pemberton',  'Analista de mercado',           'idle', 'Todavía no está conectado.', false)
on conflict (id) do nothing;
