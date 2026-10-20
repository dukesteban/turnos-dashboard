#!/usr/bin/env node
/**
 * Alta de un cliente nuevo, de punta a punta.
 *
 *   node scripts/nuevo-cliente.mjs clientes/peluqueria-ana.json
 *
 * Que hace:
 *   1. Crea el proyecto en Supabase (region de la config, plan free).
 *   2. Aplica el esquema base (`supabase/migrations/0001_base.sql`).
 *   3. Carga los datos del cliente: horarios, servicios, empleados y configuracion.
 *   4. Crea el usuario admin del panel.
 *   5. Carga los secretos del cron y agenda los dos jobs.
 *   6. Carga los secretos de las funciones y despliega las cuatro.
 *   7. Genera el environment del panel y la configuracion de build.
 *
 * Lo unico que queda a mano es subir el panel a Vercel y conectar el WhatsApp
 * (la URL del webhook se imprime al final).
 *
 * Variables de entorno necesarias:
 *   SUPABASE_ACCESS_TOKEN  token de la organizacion (sbp_...)
 *   SUPABASE_ORG_ID        id de la organizacion
 *   ANTHROPIC_API_KEY      clave de Claude (la misma para todos los clientes)
 *   GROQ_API_KEY           clave de Groq para los audios
 *
 * Flags:
 *   --existing <ref>     configurar un proyecto que ya existe (no lo crea)
 *   --db-password <pw>   password de la base, solo con --existing
 *   --dry-run            mostrar los pasos sin tocar nada
 */
import { randomBytes, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.supabase.com/v1';
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

const args = process.argv.slice(2);
const flag = (nombre) => {
  const i = args.indexOf(nombre);
  return i >= 0 ? args[i + 1] : null;
};
const DRY = args.includes('--dry-run');
const EXISTENTE = flag('--existing');
const DB_PASSWORD_EXISTENTE = flag('--db-password');
const archivoConfig = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));

if (!archivoConfig) {
  console.error('Falta el JSON del cliente. Ejemplo: node scripts/nuevo-cliente.mjs clientes/ejemplo.json');
  process.exit(1);
}

// ─── Config del cliente ────────────────────────────────────────────────────────
const cfg = JSON.parse(readFileSync(resolve(archivoConfig), 'utf8'));

const faltan = ['slug', 'nombre_negocio', 'servicios', 'empleados', 'admin'].filter((k) => !cfg[k]);
if (faltan.length) {
  console.error('Faltan campos en el JSON: ' + faltan.join(', '));
  process.exit(1);
}
if (!Array.isArray(cfg.servicios) || !cfg.servicios.length) {
  console.error('El cliente necesita al menos un servicio.');
  process.exit(1);
}
if (!cfg.admin?.usuario || !cfg.admin?.password || String(cfg.admin.password).length < 6) {
  console.error('admin.usuario y admin.password (6 caracteres o mas) son obligatorios.');
  process.exit(1);
}
if (!DRY) {
  const envFaltan = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_ORG_ID', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY'].filter(
    (k) => !process.env[k],
  );
  if (envFaltan.length) {
    console.error('Faltan variables de entorno: ' + envFaltan.join(', '));
    process.exit(1);
  }
  if (!EXISTENTE && (!cfg.meta?.token || !cfg.meta?.phone_number_id || !cfg.meta?.verify_token)) {
    console.error('Faltan meta.token, meta.phone_number_id o meta.verify_token.');
    process.exit(1);
  }
  if (EXISTENTE && !DB_PASSWORD_EXISTENTE) {
    console.error('Con --existing hace falta --db-password.');
    process.exit(1);
  }
}

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
const dia = (nombre) => {
  const i = DIAS.indexOf(norm(nombre));
  if (i < 0) throw new Error(`Dia desconocido: ${nombre}`);
  return i;
};
const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const correoDe = (usuario) => {
  const base = norm(usuario)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (base || 'usuario') + '@carwash.local';
};
const passwordAleatoria = (largo = 32) => {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: largo }, () => chars[randomInt(chars.length)]).join('');
};

// El negocio puede tener varios rangos por dia (mañana y tarde). Si el JSON no
// los trae, se usa el horario tipico de peluqueria.
const HORARIO_DEFAULT = {
  lunes: [['08:00', '12:00'], ['14:00', '20:00']],
  martes: [['08:00', '12:00'], ['14:00', '20:00']],
  miercoles: [['08:00', '12:00'], ['14:00', '20:00']],
  jueves: [['08:00', '12:00'], ['14:00', '20:00']],
  viernes: [['08:00', '12:00'], ['14:00', '20:00']],
  sabado: [['08:00', '12:00']],
  domingo: [],
};
const horarios = cfg.horarios ?? HORARIO_DEFAULT;

// ─── Helpers de API ───────────────────────────────────────────────────────────
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(ruta, opciones = {}) {
  const res = await fetch(API + ruta, {
    ...opciones,
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opciones.headers ?? {}),
    },
  });
  const texto = await res.text();
  let cuerpo = null;
  try {
    cuerpo = texto ? JSON.parse(texto) : null;
  } catch {
    cuerpo = texto;
  }
  if (!res.ok) {
    throw new Error(`${opciones.method ?? 'GET'} ${ruta} -> ${res.status}: ${texto.slice(0, 400)}`);
  }
  return cuerpo;
}

const sql = (ref, query) => api(`/projects/${ref}/database/query`, {
  method: 'POST',
  body: JSON.stringify({ query }),
});

const paso = (texto) => console.log('\n• ' + texto);

// ─── SQL de los datos ─────────────────────────────────────────────────────────
function sqlHorarios() {
  const filas = [];
  for (const [nombre, rangos] of Object.entries(horarios)) {
    for (const [desde, hasta] of rangos ?? []) {
      filas.push(`(${dia(nombre)}, '${desde}', '${hasta}', true)`);
    }
  }
  return `insert into public.horarios_atencion (dia_semana, hora_inicio, hora_fin, activo) values\n  ${filas.join(',\n  ')};`;
}

function sqlServicios() {
  const filas = cfg.servicios.map(
    (s) =>
      `(${lit(s.nombre)}, ${Number(s.precio)}, ${Number(s.duracion_minutos)}, true)`,
  );
  return `insert into public.servicios (nombre, precio, duracion_minutos, activo) values\n  ${filas.join(',\n  ')};`;
}

function jornadaDe(empleado) {
  return DIAS.map((nombre) => {
    const propios = empleado.jornada?.[nombre];
    if (propios !== undefined) {
      const r = (propios ?? [])[0];
      return r
        ? { activo: true, hora_inicio: r[0], hora_fin: r[r.length - 1] }
        : { activo: false, hora_inicio: null, hora_fin: null };
    }
    const delNegocio = horarios[nombre] ?? [];
    return delNegocio.length
      ? {
          activo: true,
          hora_inicio: delNegocio[0][0],
          hora_fin: delNegocio[delNegocio.length - 1][1],
        }
      : { activo: false, hora_inicio: null, hora_fin: null };
  });
}

function sqlEmpleados() {
  const filas = cfg.empleados.map((e) => {
    const jornada = JSON.stringify(jornadaDe(e)).replace(/'/g, "''");
    return `(${lit(e.nombre)}, ${lit(e.telefono ?? null)}, ${Number(e.comision_porcentaje ?? 0)}, true, '${jornada}'::jsonb)`;
  });
  return `insert into public.empleados (nombre, telefono, comision_porcentaje, activo, jornada) values\n  ${filas.join(',\n  ')};`;
}

function sqlConfiguracion() {
  const claves = {
    nombre_negocio: cfg.nombre_negocio,
    descripcion: cfg.descripcion ?? '',
    direccion: cfg.direccion ?? '',
    telefono_emergencia: cfg.telefono_emergencia ?? '',
    tono: cfg.tono ?? 'informal',
    horas_limite_cancelacion: String(cfg.horas_limite_cancelacion ?? 12),
    puestos_por_turno: '1',
    recordatorio_cuando: cfg.recordatorio_cuando ?? 'dia_anterior',
    recordatorio_hora: cfg.recordatorio_hora ?? '22:00',
  };
  const filas = Object.entries(claves).map(([k, v]) => `(${lit(k)}, ${lit(v)})`);
  return `insert into public.configuracion (clave, valor) values\n  ${filas.join(',\n  ')}\non conflict (clave) do update set valor = excluded.valor;`;
}

const SQL_METODOS_PAGO = `insert into public.metodos_pago (nombre, emoji, activo, orden) values
  ('Efectivo', '💵', true, 1),
  ('Tarjeta', '💳', true, 2),
  ('Transferencia', '🏦', true, 3),
  ('Mercado Pago', '🛍️', true, 4);`;

function sqlCron(ref) {
  return `select vault.create_secret(
  'https://${ref}.supabase.co/functions/v1/recordatorios',
  'cron_url',
  'URL de la funcion recordatorios'
);`;
}

// ─── Pasos ────────────────────────────────────────────────────────────────────
async function main() {
  let ref = EXISTENTE;
  let dbPassword = DB_PASSWORD_EXISTENTE;
  let publishable = null;

  if (!ref) {
    paso(`Creando el proyecto "${cfg.slug}" en ${cfg.region ?? 'sa-east-1'}...`);
    dbPassword = passwordAleatoria();
    if (!DRY) {
      const proyecto = await api('/projects', {
        method: 'POST',
        body: JSON.stringify({
          organization_id: process.env.SUPABASE_ORG_ID,
          name: cfg.slug,
          region: cfg.region ?? 'sa-east-1',
          db_pass: dbPassword,
          plan: 'free',
        }),
      });
      ref = proyecto.ref;
      console.log('  ref: ' + ref);
    } else {
      ref = 'dry-run-ref';
    }
  } else {
    console.log('• Proyecto existente: ' + ref);
  }

  if (!DRY) {
    paso('Esperando a que el proyecto este listo...');
    for (let i = 0; i < 80; i++) {
      const p = await api(`/projects/${ref}`);
      if (p.status === 'ACTIVE_HEALTHY') break;
      if (i === 79) throw new Error('El proyecto no arranco: ' + p.status);
      await dormir(5000);
    }
  }

  if (!DRY) {
    const claves = await api(`/projects/${ref}/api-keys`);
    publishable = claves.find((k) => k.type === 'publishable')?.api_key ?? null;
    if (!publishable) {
      const legacy = claves.find((k) => k.name === 'anon');
      publishable = legacy?.api_key ?? null;
    }
    if (!publishable) throw new Error('No pude leer la publishable key del proyecto.');
  }

  const dbUrl = `postgresql://postgres:${dbPassword}@db.${ref}.supabase.co:5432/postgres`;

  paso('Aplicando el esquema base...');
  if (!DRY) {
    const r = spawnSync(
      'npx',
      ['-y', 'supabase@latest', 'db', 'push', '--db-url', dbUrl, '--include-all'],
      { cwd: RAIZ, stdio: 'inherit', shell: true },
    );
    if (r.status !== 0) throw new Error('Fallo `supabase db push`.');
  }

  paso('Cargando horarios, servicios, empleados y configuracion...');
  if (!DRY) {
    await sql(ref, sqlHorarios());
    await sql(ref, sqlServicios());
    await sql(ref, sqlEmpleados());
    await sql(ref, sqlConfiguracion());
    await sql(ref, SQL_METODOS_PAGO);
  }

  paso('Creando el usuario admin del panel...');
  if (!DRY) {
    // La key nueva (sb_secret_...) todavia no la acepta el gateway de Auth: devuelve
    // "Invalid API key". La service_role legacy si funciona y es la que se usa.
    const claves = await api(`/projects/${ref}/api-keys`);
    const secreto =
      claves.find((k) => k.name === 'service_role')?.api_key ??
      claves.find((k) => k.type === 'secret')?.api_key;
    const usuario = cfg.admin.usuario;
    const correo = correoDe(usuario);
    const res = await fetch(`https://${ref}.supabase.co/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: secreto, Authorization: `Bearer ${secreto}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: correo,
        password: cfg.admin.password,
        email_confirm: true,
        user_metadata: { usuario },
        app_metadata: { rol: 'admin' },
      }),
    });
    if (!res.ok) throw new Error('No pude crear el usuario admin: ' + (await res.text()).slice(0, 300));
    await sql(
      ref,
      `insert into public.usuarios (usuario, rol, empleado_id, password_hash) values (${lit(usuario)}, 'admin', null, '');`,
    );
    console.log(`  usuario: ${usuario}   (${correo})`);
  }

  paso('Cargando secretos del cron y agendando los jobs...');
  if (!DRY) {
    const cronSecret = randomBytes(32).toString('hex');
    await sql(ref, sqlCron(ref));
    await sql(
      ref,
      `select vault.create_secret(${lit(cronSecret)}, 'cron_recordatorios', 'secreto que manda el cron en x-cron-secret');`,
    );
    await sql(
      ref,
      `select cron.schedule('recordatorios-turnos', '*/15 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cron_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_recordatorios')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 50000
  );
  $job$);`,
    );
    await sql(
      ref,
      `select cron.schedule('limpieza-tablas-bot', '0 3 * * 0', $job$ select public.limpiar_tablas_bot() $job$);`,
    );
  }

  paso('Cargando secretos de las funciones...');
  if (!DRY) {
    const envFile = join(RAIZ, 'supabase', '.temp', `secrets-${cfg.slug}.env`);
    const lineas = [
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`,
      `GROQ_API_KEY=${process.env.GROQ_API_KEY}`,
      `WHATSAPP_TOKEN=${cfg.meta.token}`,
      `WHATSAPP_PHONE_NUMBER_ID=${cfg.meta.phone_number_id}`,
      `WHATSAPP_VERIFY_TOKEN=${cfg.meta.verify_token}`,
    ];
    writeFileSync(envFile, lineas.join('\n'), 'utf8');
    const r = spawnSync(
      'npx',
      ['-y', 'supabase@latest', 'secrets', 'set', '--env-file', envFile, '--project-ref', ref],
      { cwd: RAIZ, stdio: 'inherit', shell: true },
    );
    rmSync(envFile, { force: true });
    if (r.status !== 0) throw new Error('Fallo `supabase secrets set`.');
  }

  paso('Desplegando las funciones...');
  if (!DRY) {
    const funciones = [
      ['whatsapp-bot', ['--no-verify-jwt']],
      ['recordatorios', ['--no-verify-jwt']],
      ['mensaje-cliente', []],
      ['admin-usuarios', []],
    ];
    for (const [nombre, flags] of funciones) {
      const r = spawnSync(
        'npx',
        ['-y', 'supabase@latest', 'functions', 'deploy', nombre, '--project-ref', ref, ...flags],
        { cwd: RAIZ, stdio: 'inherit', shell: true },
      );
      if (r.status !== 0) throw new Error(`Fallo el deploy de ${nombre}.`);
    }
  }

  paso('Generando el environment del panel...');
  const envPath = join(RAIZ, 'src', 'environments', `environment.${cfg.slug}.ts`);
  if (!DRY) {
    const contenido = `/**
 * ${cfg.nombre_negocio} — generado por scripts/nuevo-cliente.mjs.
 * No se edita a mano: si cambia la base, se vuelve a correr el script.
 */
export const environment = {
  production: true,
  supabaseUrl: 'https://${ref}.supabase.co',
  supabaseKey: '${publishable}',
};
`;
    writeFileSync(envPath, contenido, 'utf8');
    agregarConfigAngular(cfg.slug, `src/environments/environment.${cfg.slug}.ts`);
  }

  const webhook = `https://${ref}.supabase.co/functions/v1/whatsapp-bot`;
  console.log(`
────────────────────────────────────────────────────────────
 Listo: ${cfg.nombre_negocio}
────────────────────────────────────────────────────────────
 Supabase:  ${ref}
 Panel:     src/environments/environment.${cfg.slug}.ts

 Webhook de WhatsApp:
   ${webhook}
 Verify token:
   ${cfg.meta?.verify_token ?? '(el del JSON)'}

 Panel (a mano, una vez):
   npx ng build --configuration ${cfg.slug}
   cd dist/carwash-dashboard/browser && npx vercel --prod

 Despues, en Meta: WhatsApp -> Configuracion -> Webhook, pegar la URL
 y el verify token, y suscribir el campo "messages".
────────────────────────────────────────────────────────────
`);
}

/** Agrega la configuracion de build del cliente copiando la de produccion. */
function agregarConfigAngular(slug, archivoEnv) {
  const ruta = join(RAIZ, 'angular.json');
  const json = JSON.parse(readFileSync(ruta, 'utf8'));
  const build = json.projects['carwash-dashboard'].architect.build;
  if (build.configurations[slug]) return;
  const base = JSON.parse(JSON.stringify(build.configurations.production));
  base.fileReplacements = [{ replace: 'src/environments/environment.ts', with: archivoEnv }];
  build.configurations[slug] = base;
  writeFileSync(ruta, JSON.stringify(json, null, 2) + '\n', 'utf8');
}

main().catch((e) => {
  console.error('\n✗ ' + e.message);
  process.exit(1);
});
