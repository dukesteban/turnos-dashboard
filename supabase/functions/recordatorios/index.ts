/**
 * RECORDATORIOS DE TURNO POR WHATSAPP
 *
 * La dispara la tarea de `cron.recordatorios-turnos` (ver migracion 022) cada 15
 * minutos. Ella NO decide si es la hora: eso lo mira esta funcion, que compara con
 * `recordatorio_hora` en hora de Argentina. Si el cron se atrasa, la proxima
 * ventana de 15 minutos lo agarra igual.
 *
 * Por que esta logica vive aca y no en el cron: el cron es una linea de SQL que no
 * sabe leer configuracion ni saber que dia es "el dia anterior al turno".
 *
 * Acepta GET o POST con la palabra en `x-cron-secret`, y tambien se puede llamar a
 * mano con ?fecha=YYYY-MM-DD&forzar=1&simular=1 para probar sin esperar el horario.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WA_TOKEN = Deno.env.get('WHATSAPP_TOKEN');
const WA_PHONE_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID');
const TELEFONO_EMERGENCIA_KEY = 'telefono_emergencia';

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

/**
 * Hora de Argentina (UTC-3, sin horario de verano desde 2009).
 *
 * Se calcula a mano y no con `Intl` a proposito: la libreria trae la base de datos
 * de zonas horarias y funciona, pero `new Date().toLocaleString('es-AR', {timeZone})`
 * en Deno devuelve la fecha ya corrida y despues hay que volver a parsearla, que es
 * donde estos bugs se cuelan. UTC menos 3 es el pais.
 */
const OFFSET_AR = -3;

function ahoraArgentina(): Date {
  return new Date(Date.now() + OFFSET_AR * 3600 * 1000);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function sumarDias(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function sinSeg(h: string | null | undefined): string {
  return (h ?? '').slice(0, 5);
}

/** Ultimos 10 digitos: con o sin el 9 y el 54 de adelante, es el mismo numero. */
function ultimosDigitos(t: string | null | undefined): string {
  return (t ?? '').replace(/\D/g, '').slice(-10);
}

type Turno = {
  id: number;
  fecha: string;
  hora_inicio: string;
  hora_fin: string | null;
  servicio_nombre: string;
  cliente_nombre: string;
  cliente_telefono: string | null;
  empleado_id: number | null;
};

async function config(clave: string): Promise<string> {
  const { data } = await sb.from('configuracion').select('valor').eq('clave', clave).maybeSingle();
  return (data?.valor ?? '').trim();
}

/**
 * Arma el texto del recordatorio.
 *
 * "Hola Esteban, mañana tenés turno a las 10:00 con Juan Pérez..." y al final cómo
 * salir de ahi si se arrepiente. El nombre del empleado va solo si hay uno asignado:
 * si el turno todavia no tiene a nadie, decir "con Juan Pérez" seria inventar.
 */
function mensaje(turno: Turno, empleado: string | null, cuandoTexto: string, telAyuda: string): string {
  let cabeza = `Hola ${turno.cliente_nombre}, ${cuandoTexto} tenés turno a las ${sinSeg(turno.hora_inicio)}`;
  if (empleado) cabeza += ` con ${empleado}`;
  cabeza += '.';

  let cuerpo = cabeza;
  cuerpo += `\n\n🚗 ${turno.servicio_nombre}`;
  if (turno.hora_fin) cuerpo += ` (hasta las ${sinSeg(turno.hora_fin)})`;

  cuerpo += '\n\nSi no podés venir, avisanos por acá y lo pasamos de día.';
  if (telAyuda) cuerpo += ` O llamanos al ${telAyuda}.`;

  return cuerpo;
}

/**
 * "hoy", "mañana" o "el jueves 16 de octubre".
 *
 * No siempre es hoy ni mañana: con `?fecha=` para probar, o si el turno se creo con
 * atraso, la fecha puede estar mas lejos. Decirle "mañana" a un turno de la semana
 * que viene es mentira, asi que el caso raro cae al formato con la fecha.
 */
function cuandoTexto(fechaObjetivo: string, hoy: string): string {
  const manana = iso(sumarDias(new Date(hoy + 'T00:00:00'), 1));
  if (fechaObjetivo === hoy) return 'hoy';
  if (fechaObjetivo === manana) return 'mañana';
  const d = new Date(fechaObjetivo + 'T00:00:00');
  const dia = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][d.getDay()];
  return `el ${dia} ${d.getDate()} de ${MESES[d.getMonth()]}`;
}

const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

async function enviarA(telefono: string, texto: string): Promise<{ ok: boolean; detalle: string }> {
  // Mismo problema de siempre: Meta acepta el numero sin el 9, el webhook lo manda
  // con el 9. Se prueban las dos formas.
  const formas = [telefono];
  const digitos = ultimosDigitos(telefono);
  if (digitos.length >= 10) {
    const con9 = '549' + digitos;
    const sin9 = '54' + digitos;
    if (!formas.includes(con9)) formas.push(con9);
    if (!formas.includes(sin9)) formas.push(sin9);
  }

  let ultimo = '';
  for (const to of formas) {
    const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: texto },
      }),
    });
    if (r.ok) return { ok: true, detalle: to };
    ultimo = (await r.text()).slice(0, 300);
    // 131030 es "no autorizado": con la otra forma suele andar.
    if (!ultimo.includes('131030')) break;
  }
  return { ok: false, detalle: ultimo };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const params = url.searchParams;

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  // ─── Autorizacion ───
  // Sin esto, cualquiera que conozca la URL podria hacer que el lavadero mande
  // mensajes a todos sus clientes. El secreto sale del RPC `leer_secreto`: vault no
  // es un esquema que PostgREST exponga, asi que no se puede leer desde el cliente.
  const { data: secreto } = await sb.rpc('leer_secreto', { p_nombre: 'cron_recordatorios' });
  const esperado = (secreto as string | null) ?? '';

  const recibido = req.headers.get('x-cron-secret') ?? '';
  const esManual = params.get('forzar') === '1';
  if (!esManual && (!esperado || recibido !== esperado)) {
    return new Response(JSON.stringify({ ok: false, error: 'no autorizado' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  if (!WA_TOKEN || !WA_PHONE_ID) {
    return new Response(JSON.stringify({ ok: false, error: 'falta WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const ahora = ahoraArgentina();
  const hoy = iso(ahora);

  // ─── Que turnos hay que avisar ───
  // `recordatorio_cuando`:
  //   dia_anterior -> se avisa la vispera, asi que hoy miramos los de MAÑANA
  //   mismo_dia    -> se avisa el mismo dia del turno
  const cuando = (await config('recordatorio_cuando')) || 'dia_anterior';
  const horaConfig = (await config('recordatorio_hora')) || '21:40';

  const fechaPedida = params.get('fecha');
  const fechaObjetivo = fechaPedida
    ? fechaPedida
    : cuando === 'mismo_dia'
      ? hoy
      : iso(sumarDias(ahora, 1));

  // ─── Es la hora? ───
  // Ventana de 15 minutos, que es lo mismo que el intervalo del cron. Se comparan
  // solo hora y minuto en Argentina.
  if (!esManual) {
    const actual = hhmm(ahora);
    const [hC, mC] = horaConfig.split(':').map(Number);
    const [hA, mA] = actual.split(':').map(Number);
    const minutosConfig = (hC || 0) * 60 + (mC || 0);
    const minutosActual = (hA || 0) * 60 + (mA || 0);
    // La ventana es [config, config+15): si ya paso, no hay nada que hacer. El cron
    // vuelve a disparar cada 15 minutos y entra en la proxima.
    if (minutosActual < minutosConfig || minutosActual >= minutosConfig + 15) {
      return new Response(
        JSON.stringify({
          ok: true,
          enviado: 0,
          motivo: 'fuera_de_horario',
          ahora_argentina: `${hoy} ${actual}`,
          configurado: horaConfig,
          proxima_ventana: horaConfig,
        }),
        { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
      );
    }
  }

  // ─── Turnos pendientes de esa fecha, con telefono ───
  const { data: turnos, error } = await sb
    .from('turnos')
    .select('id, fecha, hora_inicio, hora_fin, servicio_nombre, cliente_nombre, cliente_telefono, empleado_id')
    .eq('fecha', fechaObjetivo)
    .eq('estado', 'pendiente');
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const candidatos = (turnos ?? []).filter((t: any) => ultimosDigitos(t.cliente_telefono).length >= 10);

  // ─── Los que YA se avisaron ───
  // El unique en turno_id es la garantia real de no duplicar, pero se consulta antes
  // para no gastar llamadas de la API de Meta en turnos que ya salieron.
  const { data: yaEnviados } = await sb
    .from('recordatorios_enviados')
    .select('turno_id')
    .in('turno_id', candidatos.map((t: any) => t.id));

  const vistos = new Set((yaEnviados ?? []).map((r: any) => r.turno_id));
  const pendientes = candidatos.filter((t: any) => !vistos.has(t.id));

  const cuandoTextoMsg = cuandoTexto(fechaObjetivo, hoy);
  const telAyuda = await config(TELEFONO_EMERGENCIA_KEY);

  const ids = new Set(pendientes.map((t: any) => t.empleado_id).filter((x: any) => x != null));
  const { data: empleados } = ids.size
    ? await sb.from('empleados').select('id, nombre').in('id', Array.from(ids))
    : { data: [] as Array<{ id: number; nombre: string }> };
  const nombreDe = new Map((empleados ?? []).map((e: any) => [e.id, e.nombre]));

  const detalle: any[] = [];
  let enviados = 0;
  // `simular=1` arma los textos y los devuelve SIN mandarlos ni marcar nada: es
  // para ver que quedaria escrito antes de dejarlo corriendo solo.
  const simular = params.get('simular') === '1';

  for (const turno of pendientes as Turno[]) {
    const texto = mensaje(turno, turno.empleado_id ? (nombreDe.get(turno.empleado_id) ?? null) : null, cuandoTextoMsg, telAyuda);

    if (simular) {
      detalle.push({ turno_id: turno.id, a: turno.cliente_telefono, simulado: true, texto });
      continue;
    }

    const r = await enviarA(turno.cliente_telefono!, texto);

    if (r.ok) enviados++;
    detalle.push({ turno_id: turno.id, ok: r.ok, a: r.ok ? r.detalle : null, error: r.ok ? null : r.detalle });

    // Se registra el intento GANE O FALLE: si se marcara solo cuando tendria exito, un
    // turno que falla por un error de Meta se reintentaria cada 15 minutos para
    // siempre. Se registra igual y el fallo queda a la vista para verlo en el panel.
    await sb.from('recordatorios_enviados').insert({
      turno_id: turno.id,
      telefono: turno.cliente_telefono,
      exito: r.ok,
      detalle: r.ok ? null : r.detalle?.slice(0, 300) ?? null,
    });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      simulado: simular,
      fecha_objetivo: fechaObjetivo,
      cuando,
      total_turnos: (turnos ?? []).length,
      sin_telefono: (turnos ?? []).length - candidatos.length,
      ya_avisados: vistos.size,
      enviados,
      detalle,
    }),
    { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
  );
});