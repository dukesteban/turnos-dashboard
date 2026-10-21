// ═══════════════════════════════════════════════════════════════════════════
// whatsapp-bot
// ═══════════════════════════════════════════════════════════════════════════
//
// El bot de WhatsApp del lavadero. Se entera de los mensajes por el webhook de Meta,
// le habla a Claude con las tools de la spec, y responde por la Cloud API de WhatsApp.
//
// Como esta hecho
// ----------------
//
// Es un servidor de un endpoint POST (ademas del GET de verificacion de Meta). Cada
// mensaje que llega:
//
//   1. Se busca la conversacion activa por `telefono` en `conversaciones`.
//   2. Se arma el prompt: identity del negocio, el spec y el historial de la charla.
//   3. Se llama a Claude con las tools definidas abajo. Si Claude pide una tool, se
//      ejecuta aca, contra la misma base, y se le devuelve el resultado.
//   4. La respuesta se manda al cliente por la Cloud API de WhatsApp, y se guarda en
//      `conversaciones` para la proxima.
//
// Las tools devuelven ERROR COMO DATO (`{ ok: false, error: "..." }`) y no tiran
// excepciones: es el contrato de la spec, porque el modelo puede explicarle el error
// al cliente, mientras que una excepcion se convierte en un mensaje generico.
//
// Lo que NO hace esto (y lo hace la capa de datos, por contrato de la spec)
//
// Las REGLAS de negocio (no reservar si esta cerrado, no cancelar fuera de plazo, no
// reservar en el pasado) se validan ACA antes de tocar la base. El modelo puede
// equivocarse; la capa de datos no deja pasar la operacion.
//
// Lo que falta para ponerlo en vivo
//
//   - Env vars: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_VERIFY_TOKEN`,
//     `ANTHROPIC_API_KEY` (ya esta), y `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
//     que Supabase pone solo.
//   - Apuntar el webhook de Meta a esta URL.
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC = Deno.env.get('ANTHROPIC_API_KEY')!;
const WA_TOKEN = Deno.env.get('WHATSAPP_TOKEN') ?? '';
const WA_PHONE_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') ?? '';
// Si no esta, los audios siguen contestando el aviso de "escribinos". Asi se
// puede prender solo en el proyecto de prueba.
const GROQ_KEY = Deno.env.get('GROQ_API_KEY') ?? '';
const VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN') ?? '';

const sb = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

/**
 * Una clave suelta de `configuracion`, o "" si no está.
 *
 * Vive acá y no dentro de `ejecutarTool` porque la usan cosas que NO son tools: los
 * links del calendario y el .ics tienen que traer el nombre del negocio y la
 * dirección, y ninguno de los dos pasa por el modelo.
 */
async function config(clave: string): Promise<string> {
  const { data } = await sb.from('configuracion').select('valor').eq('clave', clave).maybeSingle();
  return (data?.valor ?? '').trim();
}

// ─── Links del calendario que hay que mandar al final del mensaje ───
//
// El modelo NO es confiable para esto. Se probo: la tool devuelve `calendario` y en
// una de cada dos confirmaciones lo copia al mensaje; en la otra se olvida y el
// cliente recibe un turno confirmado sin ninguna forma de guardarlo.
//
// Con el mismo criterio que el "un momento, chequeo": si algo tiene que pasar SIEMPRE,
// no se le pide al modelo que se acuerde, lo hace el codigo. El modelo sigue
// escribiendo la frase natural ("ahora te paso el link...") y el codigo agrega los
// links si no los puso.
//
// Se vacia en cada mensaje: son de ESE turno, no de todos.
let pendientesDeCalendario: { google: string; ics: string }[] = [];

let falloTecnico = false;

/** Los links si el modelo ya los puso, para no mandarlos dos veces. */
function yaEstanEnElTexto(texto: string, c: { google: string; ics: string }): boolean {
  return texto.includes(c.google) || texto.includes(c.ics);
}

/** Las URLs de un texto, sin el punto ni la coma que se pegan al final. */
function urlsDe(texto: string): string[] {
  // El `\` sale de `JSON.stringify`: los links dentro de los tool_result quedan
  // como `...ics?i=806\"` y sin sacarlo la URL no coincide con la del mensaje.
  return (String(texto ?? '').match(/https?:\/\/[^\s<>"'()*\\]+/g) ?? [])
    .map((u) => u.replace(/[.,;:!?\\]+$/, ''))
    .filter(Boolean);
}

/**
 * La "huella" de un link de calendario: lo que lo ata a ESE turno.
 *
 * Los links reales los arma `linksDeCalendario` y siempre llevan el id del turno
 * (`.ics?i=806`) o las fechas del evento (Google). Se compara la huella y no la URL
 * entera porque el modelo cambia una cosa por otra al copiarla (`%20` por `+`,
 * mayusculas) y no queremos marcar como inventado un link que si es.
 */
function huellaDeLink(url: string): string | null {
  const ics = url.match(/[?&]i=(\d+)/);
  if (ics) return `turno:${ics[1]}`;
  const fechas = url.match(/[?&]dates=([^&]+)/);
  if (fechas) return `fechas:${fechas[1]}`;
  return null;
}

/**
 * Los links de la respuesta que NO devolvio ninguna tool.
 *
 * Existe por un caso real y caro: la clienta acepto el horario, el modelo escribio
 * "te dejo el turno para el miercoles 21 a las 15:15" con los dos links... sin llamar
 * a `crear_turno`. Los links los invento (un `prod-peluqueria.turnos.app/calendar/...`
 * y un Google `eventedit` con otra forma), el turno no existia, y dos mensajes
 * despues el bot le dijo "no tengo ningun turno registrado para vos".
 *
 * El link es la unica parte de esa confirmacion que no se puede inventar sin que se
 * note: los reales salen de la tool. Si aparece uno que no esta en la conversacion,
 * la confirmacion tambien es inventada.
 */
function linksInventados(texto: string, historial: any[]): string[] {
  const conocidos = new Set<string>();
  for (const u of urlsDe(JSON.stringify(historial))) {
    conocidos.add(u);
    const h = huellaDeLink(u);
    if (h) conocidos.add(h);
  }
  return urlsDe(texto).filter((u) => {
    if (conocidos.has(u)) return false;
    const h = huellaDeLink(u);
    return !h || !conocidos.has(h);
  });
}

const AVISO_LINKS_INVENTADOS =
  '[Aviso del sistema, no lo ve el cliente] Tu respuesta anterior tenia links de calendario que ' +
  'ninguna tool devolvio: los inventaste. Eso significa que tambien inventaste el turno. ' +
  'Corregilo AHORA: si el cliente ya eligio servicio, dia y hora, llamá a crear_turno (o a ' +
  'reprogramar_turno sobre el turno que corresponda) y recien despues confirmá con los links que ' +
  'devuelva la tool. Si falta algun dato, pediselo. No escribas ningun link que no haya vuelto de ' +
  'una tool, y no confirmes un turno que no creaste.';

// ─── AGENDAR EL TURNO EN EL CALENDARIO DEL CLIENTE ───
//
// Después de confirmar, el cliente quiere tenerlo en su calendario, no anotado en un
// chat. Se le dan dos links:
//
//   · Google Calendar: una URL que abre el formulario de "crear evento" ya completo.
//     Google la genera sola, no hace falta ningún archivo.
//   · iOS (y Android, y Outlook, y desktop): un archivo .ics, que es EL estándar.
//     El calendario de Apple lo abre al tocarlo.
//
// El .ics lo sirve esta misma función en `/turno.ics`, así que no hay que subir
// ningún archivo a ningún lado ni guardar el calendario en una tabla.

/**
 * Argentina es UTC-3 fijo desde 2009 (no hay horario de verano).
 *
 * Se usa el mismo -3 en los dos lados, no `toISOString()` sobre una fecha parseada
 * sin zona, que es donde estos cálculos se corren un día.
 */
const OFFSET_AR = -3;

/**
 * El momento exacto (en milisegundos) de una fecha y hora DEL LOCAL.
 *
 * Existe porque la funcion corre en UTC y Argentina es UTC-3: un
 * `new Date('2026-10-19T10:00')` es el turno de las 10:00 de Argentina leido
 * como 10:00 UTC, o sea tres horas ANTES de lo que es. Con el plazo de 12 horas
 * esa diferencia se come tres horas de margen y el bot le dice que no a un turno
 * que todavia se puede mover.
 */
function msLocales(fechaISO: string, hhmm: string): number {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0) - OFFSET_AR * 3600 * 1000;
}

function utcDesdeLocal(fechaISO: string, hhmm: string): string {
  // "YYYY-MM-DD" + "HH:MM" -> timestamp en UTC -> "YYYYMMDDTHHMMSSZ"
  return new Date(msLocales(fechaISO, hhmm)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Escapa un texto para .ics.
 *
 * El RFC 5545 obliga a escapar la coma, el punto y coma, la barra invertida y los
 * saltos de línea. Sin esto, un servicio que se llame "Corte, lavado" parte el
 * evento en dos y el calendario muestra basura.
 */
function icsEscapar(s: string): string {
  return (s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * El precio como lo escribe un humano: "$58.000".
 *
 * Devuelve el prefijo completo con el guion y el espacio, o cadena vacia si el turno no
 * tiene precio cargado. Un turno sin precio es raro pero pasa en los turnos de prueba, y
 * un "Lavado - $NaN - RyF" en el calendario del cliente es peor que no poner precio.
 */
function precioLegible(precio: number | string | null | undefined): string {
  const n = Number(precio);
  return precio == null || precio === '' || !Number.isFinite(n) ? '' : ` - $${Math.round(n).toLocaleString('es-AR')}`;
}

/**
 * El .ics del turno. Fines de línea CRLF, que es lo que pide el RFC.
 *
 * SOLO va el nombre del negocio, el servicio y el precio. Antes también iban la
 * dirección y un "para cambiarlo o cancelarlo escribinos por acá", y en Android eso
 * es lo primero que se lee al abrir el evento: ocupa media pantalla con algo que el
 * cliente ya sabe y que tiene a mano en el chat de todos modos. Y el link, que es lo
 * que el cliente ve en la conversación, queda mas corto.
 */
function icsDelTurno(t: {
  id: number; servicio_nombre: string; precio?: number | string | null;
  fecha: string; hora_inicio: string; hora_fin: string; negocio: string;
}): string {
  const f = (v: string) => icsEscapar(v);
  const titulo = `${t.servicio_nombre}${precioLegible(t.precio)} - ${t.negocio}`;
  const lineas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${f(t.negocio)}//Turnos//ES`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    // El UID tiene que ser único y estable: es lo que hace que el calendario
    // actualice el evento en vez de duplicarlo si el cliente toca el link dos veces.
    `UID:turno-${t.id}@${new URL(SUPABASE_URL).host}`,
    `DTSTAMP:${utcDesdeLocal(t.fecha, '12:00')}`,
    `DTSTART:${utcDesdeLocal(t.fecha, String(t.hora_inicio).slice(0, 5))}`,
    `DTEND:${utcDesdeLocal(t.fecha, String(t.hora_fin ?? t.hora_inicio).slice(0, 5))}`,
    `SUMMARY:${f(titulo)}`,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${f(titulo)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lineas.join('\r\n') + '\r\n';
}

/**
 * Firma del link del .ics, para que no se pueda adivinar el turno de otro.
 *
 * Sin esto, `?id=1`, `?id=2`... dejaría que cualquiera que tuviera la URL base
 * leyera los turnos de todos los clientes del local. Con la firma, hace falta el
 * secreto.
 */async function firmaDeTurno(id: number): Promise<string> {
  const clave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(VERIFY_TOKEN || 'carwash'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const buf = await crypto.subtle.sign('HMAC', clave, new TextEncoder().encode(`turno:${id}`));
  // 16 hex = 64 bits. La firma no evita que alguien que ya tiene un link lo use: para
  // eso está el JWT en el webhook. Lo que evita es que se pueda BARRIENDO numeros
  // (`?i=1`, `?i=2`...) y leer los turnos de todos los clientes, y 64 bits sobra para
  // eso. Con 32 el link queda el doble de largo y no compra nada.
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/**
 * Los dos links que se le mandan al cliente al confirmar.
 *
 * El de Google va con lo MINIMO: nombre del servicio, precio y nombre del negocio, que
 * es lo unico que el cliente necesita para reconocer el turno en su lista. Antes tambien
 * iban la direccion y un "para cambiarlo o cancelarlo escribinos por aca", y cada uno
 * sumaba sus cuantos caracteres codificados al link entero. El link se copia, se pega y
 * se manda por WhatsApp: cada caracter de mas es un caracter de mas en el chat.
 *
 * Sin `ctz`: las fechas van en UTC con la Z, asi que Google las convierte solo a la zona
 * de quien las abre. El parametro solo servia para cuando la fecha venia sin zona.
 */
async function linksDeCalendario(t: {
  id: number; servicio_nombre: string; precio?: number | string | null;
  fecha: string; hora_inicio: string; hora_fin: string;
}): Promise<{ google: string; ics: string }> {
  const negocio = await config('nombre_negocio');

  const ini = utcDesdeLocal(t.fecha, String(t.hora_inicio).slice(0, 5));
  const fin = utcDesdeLocal(t.fecha, String(t.hora_fin ?? t.hora_inicio).slice(0, 5));
  const precio = precioLegible(t.precio);
  const resumen = `${t.servicio_nombre}${precio} - ${negocio}`;

  const google =
    'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    `&text=${encodeURIComponent(resumen)}` +
    `&dates=${ini}/${fin}`;

  const firma = await firmaDeTurno(t.id);
  // `i` y no `id`: cuatro caracteres por link no son nada, pero el link va a leer un
  // humano en un chat y cada cosa que se pueda sacar ahí se saca.
  const ics = `${SUPABASE_URL}/functions/v1/whatsapp-bot/turno.ics?i=${t.id}&f=${firma}`;

  return { google, ics };
}

// ─── Tools, con sus descripciones para el modelo ───
// El nombre va con guion bajo porque Anthropic no acepta guionesmedios en los nombres
// de tools. La descripcion le dice al modelo QUE hace y CUANDO la usa.
const TOOLS = [
  {
    name: 'obtener_config_negocio',
    description: 'Obtiene una clave de la configuracion del negocio: nombre_negocio, descripcion, direccion, telefono_emergencia, tono, horas_limite_cancelacion, horario_atencion, dias_cerrados, recordatorio_cuando, recordatorio_hora.',
    input_schema: { type: 'object', properties: { clave: { type: 'string' } }, required: ['clave'] },
  },
  {
    name: 'empleados_del_dia',
    description:
      'Devuelve quienes trabajan en una fecha, con el horario de cada uno. Usala cuando el cliente pregunte quien trabaja un dia, sin pedirle un servicio: es una pregunta de gente, no de turnos.',
    input_schema: {
      type: 'object',
      properties: { fecha: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['fecha'],
    },
  },
  {
    name: 'asociar_numero',
    description:
      'Agrega el numero desde el que esta escribiendo el cliente a una ficha que ya existe. Usala SOLO cuando el cliente confirmo que es la misma persona que ya tenemos con otro numero.',
    input_schema: {
      type: 'object',
      properties: { cliente_id: { type: 'number' } },
      required: ['cliente_id'],
    },
  },
  {
    name: 'listar_servicios',
    description: 'Devuelve la lista de servicios disponibles con id, nombre, duracion en minutos y precio.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'buscar_empleados',
    description:
      'Devuelve los empleados activos. Si el cliente quiere que lo atienda ALGUIEN para un turno, pasale SIEMPRE la fecha: la lista sale SOLO de quien trabaja ese día, con su horario, y en no_disponibles viene quien no puede, con el motivo. Sin fecha devuelve todos los activos a ciegas. Si el cliente nombro a una persona concreta ("con Laura", "quiero que me atienda Juan"), pasale el nombre en `nombre`: la tool te dice si esa persona trabaja aca o no, y cual es su id. NO compares vos el nombre con la lista: se vio al modelo decir "Laura trabaja aca" con Laura ausente de la lista, y "con Laura si esta disponible" cuando Laura no existe.',
    input_schema: {
      type: 'object',
      properties: {
        fecha: {
          type: 'string',
          description: 'YYYY-MM-DD. OBLIGATORIA cuando el cliente quiere un empleado para un turno: sin ella podes ofrecer a alguien que ese día no trabaja y tener que dar marcha atrás.',
        },
        nombre: {
          type: 'string',
          description: 'El nombre que dijo el cliente, tal cual lo dijo, si nombró a alguien. La tool verifica si existe y devuelve encontrado true/false con el detalle para que le digas.',
        },
        hora: {
          type: 'string',
          description: 'HH:MM, SOLO si el cliente dijo a que hora quiere. Con hora, la lista es de quien puede TOMAR el turno a esa hora, no solo de quien trabaja ese dia: son dos cosas distintas y se confundian. Pasale tambien servicio_id para saber cuanto dura.',
        },
        servicio_id: {
          type: 'number',
          description: 'Solo junto con `hora`, para calcular si el turno entra en el horario de cada uno.',
        },
      },
      required: [],
    },
  },
  {
    name: 'consultar_horarios_libres',
    description:
      'Devuelve los horarios libres para un servicio y fecha. Los UNICOS horarios que te podes ofrecer son los que aparecen en `libres` y `sugerencias`: los demas no existen. Si el cliente dijo a que hora queria, pasala en hora_preferida: la lista vuelve ordenada de esa hora hacia atras, y te dice si esa hora exacta se puede. Si NO se puede, sugerencias viene numerada y de mas cerca a mas lejos (una antes y otra despues de la que pidio) y recomendada es la primera: esa es la que tenes que proponer. Si en `libres` no hay nada de la franja que pidio, esa franja esta LLENA: decilo y ofrecele otro dia. NUNCA deduzcas un horario libre de la hora de apertura del local: que abra de 14:00 a 20:00 no dice si hay lugar a las 14:00. Devuelve tambien el motivo si no se puede.',
    input_schema: {
      type: 'object',
      properties: {
        servicio_id: { type: 'number', description: 'El id SOLO si lo leiste de listar_servicios en este mensaje. Si no, usa servicio_nombre.' },
        servicio_nombre: { type: 'string', description: 'El nombre del servicio tal cual lo dijo el cliente (ej. "lavado con cera"). La base lo resuelve. Preferilo si no tenes el id.' },
        fecha: { type: 'string', description: 'YYYY-MM-DD' },
        hora_preferida: { type: 'string', description: 'HH:MM de lo que pidio el cliente, si dijo una' },
        empleado_id: { type: 'number', description: 'Solo si el cliente quiere un empleado concreto' },
        cantidad: {
          type: 'number',
          description: 'Cuantos horarios queres que te devuelva. Por omision 3, que es lo que se le ofrece al cliente. Subilo solo si el cliente pide ver mas.',
        },
      },
      required: ['fecha'],
    },
  },
  {
    name: 'buscar_cliente',
    description:
      'Devuelve el cliente ya registrado con el numero desde el que escribe el cliente (id, nombre). Llamala PRIMERO, antes de pedirle el nombre: si ya existe, saludalo por su nombre y no se lo vuelvas a preguntar. Si devuelve null, es un cliente nuevo y hay que pedirle el nombre.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'crear_turno',
    description:
      'Crea un turno despues de que el cliente confirmo. Si el cliente ya estaba registrado, no hace falta pasarle nombre_cliente (se resuelve solo por el numero). Si la hora exacta esta tomada pero el cliente ya acepto que le ofrezcas otra cercana, pasa tambien aceptar_cercania_minutos: la tool elige sola el horario libre mas cercano y te devuelve cual quedo en hora_reservada. Si no tiene disponibilidad, devuelve error.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_cliente: { type: 'string', description: 'Solo si el cliente es nuevo, o si el turno es para OTRA PERSONA (ahí va el nombre y apellido de esa persona, aunque el que escribe ya esté registrado). SIEMPRE nombre Y apellido: si el cliente dijo un solo nombre, la tool devuelve falta_apellido y hay que preguntárselo antes de agendar. No inventes el apellido.' },
        servicio_id: { type: 'number', description: 'El id SOLO si lo leiste de listar_servicios en este mensaje. Si no, usa servicio_nombre.' },
        servicio_nombre: { type: 'string', description: 'El nombre del servicio tal cual lo dijo el cliente. La base lo resuelve y evita agendar otro servicio con otro precio.' },
        fecha_hora: { type: 'string', description: 'ISO 8601, zona del negocio' },
        empleado_id: { type: 'number', description: 'Solo si el cliente quiere un empleado concreto. Si no, se asigna el primero libre.' },
        aceptar_cercania_minutos: {
          type: 'number',
          description:
            'Solo si el cliente YA ACEPTO un horario cercano porque el que pidio estaba tomado. Cuantos minutos a la redonda puede correrse la hora: 30, 60, 90. La tool elige el libre mas cercano y devuelve hora_reservada. Si no lo pones (o 0), se respeta la hora exacta y, si esta tomada, falla.',
        },
      },
      required: ['fecha_hora'],
    },
  },
  {
    name: 'buscar_turnos_cliente',
    description:
      'Busca los turnos del cliente por su numero de WhatsApp. Devuelve SOLO los que todavia no terminaron y sin cancelados; cada uno viene con se_puede_mover (si ya no se puede mover ni cancelar por el plazo, viene false y el motivo). Cada turno trae cliente_nombre: si pregunta por los de otra persona (su hijo, una amiga), mostra solo los que tienen ese nombre. Pon incluir_pasados=true solo si el cliente pidio explicitamente ver el historico.',
    input_schema: {
      type: 'object',
      properties: {
        incluir_pasados: { type: 'boolean', description: 'true solo si el cliente pidio el historico. Por omision no.' },
      },
      required: [],
    },
  },
  {
    name: 'corregir_nombre_cliente',
    description:
      'Corrige el nombre de un cliente YA registrado, cuando se equivoco al dictarlo o escribio mal su apellido. Es el nombre del CLIENTE, no el del turno. IMPORTANTE: llamala DOS veces. La primera con confirmado:false, que devuelve el nombre actual y el nuevo para que se los muestres al cliente y el diga que si. Solo si el cliente confirma, la llamás otra vez con confirmado:true y ahi se aplica. La correccion tambien actualiza el nombre en los turnos anteriores del cliente.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_nuevo: { type: 'string', description: 'Nombre y apellido completos, tal cual lo quiere el cliente.' },
        confirmado: { type: 'boolean', description: 'false para ver el cambio sin aplicarlo, true para aplicarlo.' },
      },
      required: ['nombre_nuevo'],
    },
  },
  {
    name: 'cancelar_turno',
    description: 'Cancela un turno. Si faltan menos horas que el minimo configurado, devuelve error fuera_de_plazo.',
    input_schema: {
      type: 'object',
      properties: { turno_id: { type: 'number' } },
      required: ['turno_id'],
    },
  },
  {
    name: 'reprogramar_turno',
    description: 'Cambia la fecha y/o la hora de un turno, y tambien puede cambiar el empleado que lo atiende. Usala cuando el cliente quiere otro horario o que lo atienda otra persona. Si el horario nuevo no esta libre, el empleado no trabaja ese dia, o el turno ya paso, devuelve error.',
    input_schema: {
      type: 'object',
      properties: {
        turno_id: { type: 'number' },
        nueva_fecha_hora: { type: 'string', description: 'ISO 8601, zona del negocio. Si el cliente pide cambiar SOLO la hora ("a las 16", "mas tarde", "mas temprano"), mandalo como "16:00" y la fecha se mantiene sola: no recalcules el dia. Si el cliente pidio otro dia, mandalo completo.' },
        empleado_id: { type: 'number', description: 'Solo si el cliente pidio que lo atienda otra persona. Verificalo antes con consultar_horarios_libres.' },
      },
      required: ['turno_id', 'nueva_fecha_hora'],
    },
  },
];

// ─── Tres cosas que hay que validar antes de tocar la base ───
// Son las reglas que la spec dice que van en la capa de datos: el modelo se equivoca,
// la capa no lo deja pasar.
function err(codigo: string, detalle = '') {
  return JSON.stringify({ ok: false, error: codigo, detalle });
}

function cierreQueCubre(cerrados: Array<{ fecha: string; fecha_hasta?: string | null; motivo?: string | null }>, fecha: string): { fecha: string; fecha_hasta?: string | null; motivo?: string | null } | null {
  // Un día cerrado sin fecha_hasta aplica SOLO ese día. Con fecha_hasta, aplica todo el
  // rango. La condición anterior (`lte(fecha) + or(fecha_hasta >= x, is null)`) contaba
  // COMO CERRADOS POR SIEMPRE los que tenían fecha_hasta NULL, porque esa cláusula
  // matchea cualquier fecha posterior a la del cierre.
  const D = new Date(fecha + 'T00:00:00').getTime();
  return (cerrados ?? []).find((c: any) => {
    const desde = new Date(c.fecha + 'T00:00:00').getTime();
    const hasta = c.fecha_hasta ? new Date(c.fecha_hasta + 'T00:00:00').getTime() : desde;
    return desde <= D && D <= hasta;
  }) ?? null;
}

function diaCerrado(cerrados: Array<{ fecha: string; fecha_hasta?: string | null }>, fecha: string): boolean {
  return cierreQueCubre(cerrados, fecha) !== null;
}

/**
 * El "detalle" que se le devuelve al modelo cuando un dia esta cerrado.
 *
 * Lleva el MOTIVO cuando lo cargaron: sin esto el bot solo podia decir "ese dia
 * esta cerrado", y el cliente preguntaba por que. El motivo ya esta en
 * `dias_cerrados`; no hay razon para que el modelo tenga que ir a buscarlo aparte.
 */
function detalleCerrado(cierre: { motivo?: string | null } | null): string {
  const motivo = (cierre?.motivo ?? '').trim();
  return motivo
    ? `Ese dia el negocio esta cerrado por ${motivo}. Deciselo al cliente con la razon.`
    : 'Ese dia el negocio esta cerrado.';
}

async function horasMinCancelar(): Promise<number> {
  const { data } = await sb.from('configuracion').select('valor').eq('clave', 'horas_limite_cancelacion').single();
  return Number(data?.valor) || 12;
}

/**
 * El telefono del local, para los casos que el bot no puede resolver.
 *
 * Sale de Configuracion (`telefono_emergencia`), asi que el negocio lo cambia sin
 * tocar codigo. Se usa cuando un turno ya no se puede mover ni cancelar: mandar al
 * cliente "comunicate con el local" sin darle el numero es dejarlo donde estaba.
 */
async function telefonoDelLocal(): Promise<string> {
  const { data } = await sb.from('configuracion').select('valor').eq('clave', 'telefono_emergencia').maybeSingle();
  return (data?.valor ?? '').trim();
}

const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

/**
 * "viernes 30 de octubre": el dia de la semana ya resuelto.
 *
 * Va en los resultados de las tools porque el modelo lo calculaba solo y se
 * equivocaba: en la misma conversacion dijo "jueves 30" y despues "viernes 30"
 * para el mismo turno. La tabla de dias del prompt alcanza para hablar del
 * futuro, no para traducir una fecha que ya viene de la base.
 */
function fechaTexto(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  const dia = DIAS_SEMANA[d.getDay()].replace('miercoles', 'miércoles').replace('sabado', 'sábado');
  return `${dia} ${d.getDate()} de ${MESES[d.getMonth()]}`;
}

// ─── Nombre del negocio y proximos cierres, para la presentacion ───
// El cierre se lee de `dias_cerrados`: si el lavadero carga un feriado ahi, el bot lo
// dice solo, sin que nadie se lo recuerde en cada mensaje.
const TONOS: Record<string, string> = {
  informal: 'Hablás como en un chat: voseo, frases cortas, sin tratar a nadie de "estimado". Que parezca una persona, no un formulario.',
  profesional: 'Profesional pero humano: voseo, claro y respetuoso, sin vulgaridades ni exageraciones de "esto es un bot".',
  formal: 'Formal: trato de "usted", ustedes, más cuidado en las frases, sin apuro. Para un cliente que se queja o consulta un reclamo.',
};

/**
 * Los horarios de atencion en una linea, agrupados por dia:
 * "lunes a viernes de 08:00 a 12:00 y de 14:00 a 20:00, sabado de 08:00 a 12:00, domingo: cerrado".
 *
 * Va en la parte variable del prompt para que el bot pueda mandar los horarios en el
 * primer mensaje sin gastar una vuelta. Antes tenia que llamar una tool, y el cliente
 * leia "decime que necesitas" y recien en el mensaje siguiente los horarios.
 */
function horariosDeAtencion(filas: any[]): string | null {
  const porDia = new Map<number, string[]>();
  for (const h of filas ?? []) {
    if (h.activo === false) continue;
    const rango = `${sinSeg(h.hora_inicio)} a ${sinSeg(h.hora_fin)}`;
    porDia.set(h.dia_semana, [...(porDia.get(h.dia_semana) ?? []), rango]);
  }
  if (porDia.size === 0) return null;

  // Semana de lunes a domingo: es como se lee el horario de un local.
  const orden = [1, 2, 3, 4, 5, 6, 0];
  const tramos: Array<{ dias: number[]; texto: string }> = [];
  for (const dia of orden) {
    const rangos = porDia.get(dia);
    const texto = rangos?.length ? rangos.join(' y ') : 'cerrado';
    const ultimo = tramos[tramos.length - 1];
    if (ultimo && ultimo.texto === texto) ultimo.dias.push(dia);
    else tramos.push({ dias: [dia], texto });
  }

  return tramos
    .map(({ dias, texto }) => {
      const nombre = dias.length === 1
        ? DIAS_SEMANA[dias[0]]
        : `${DIAS_SEMANA[dias[0]]} a ${DIAS_SEMANA[dias[dias.length - 1]]}`;
      if (texto === 'cerrado') return `${nombre}: cerrado`;
      const horas = texto.split(' y ');
      return `${nombre} de ${horas.join(' y de ')}`;
    })
    .join(', ');
}

/**
 * Resuelve el servicio que pidio el cliente a partir del id o del NOMBRE.
 *
 * El modelo casi siempre tiene el nombre ("lavado con cera") y no el id. Cuando le
 * pediamos solo `servicio_id`, lo inventaba: en una prueba de 10 turnos, 3 quedaron
 * como "Lavado completo" aunque el cliente habia pedido encerado, cera y lavado y
 * encerado. No es un error de redaccion: es un turno con otro precio y otra duracion.
 * Aceptando el nombre, lo resuelve la base.
 */
async function resolverServicio(input: any): Promise<
  | { ok: true; servicio: any }
  | { ok: false; respuesta: string }
> {
  const plano = (s: any) =>
    String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const nombre = typeof input?.servicio_nombre === 'string' ? input.servicio_nombre.trim() : '';
  const id = Number(input?.servicio_id);

  if (nombre) {
    const { data } = await sb.from('servicios').select('id, nombre, duracion_minutos, precio, activo');
    const lista = (data ?? []).filter((s: any) => s.activo !== false);
    const buscado = plano(nombre);
    let elegido = lista.find((s: any) => plano(s.nombre) === buscado);

    if (!elegido) {
      const parecidos = lista.filter((s: any) => {
        const n = plano(s.nombre);
        return n.includes(buscado) || buscado.includes(n);
      });
      if (parecidos.length === 1) {
        elegido = parecidos[0];
      } else if (parecidos.length > 1) {
        return {
          ok: false,
          respuesta: JSON.stringify({
            ok: false,
            error: 'servicio_ambiguo',
            servicios: parecidos.map((s: any) => ({ id: s.id, nombre: s.nombre })),
            detalle: `"${nombre}" puede ser mas de uno. Preguntale al cliente cual quiere y pasa el nombre exacto en servicio_nombre.`,
          }),
        };
      }
    }

    if (elegido) return { ok: true, servicio: elegido };

    return {
      ok: false,
      respuesta: JSON.stringify({
        ok: false,
        error: 'servicio_no_encontrado',
        servicios: lista.map((s: any) => ({ id: s.id, nombre: s.nombre })),
        detalle: `No hay ningun servicio llamado "${nombre}". Usa uno de \`servicios\`; no inventes el nombre ni el id.`,
      }),
    };
  }

  if (Number.isFinite(id) && id > 0) {
    const { data } = await sb
      .from('servicios')
      .select('id, nombre, duracion_minutos, precio')
      .eq('id', id)
      .maybeSingle();
    if (data) return { ok: true, servicio: data };
  }

  const { data } = await sb.from('servicios').select('id, nombre').eq('activo', true).order('nombre');
  return {
    ok: false,
    respuesta: JSON.stringify({
      ok: false,
      error: 'falta_servicio',
      servicios: data ?? [],
      detalle: 'Falta el servicio: pasa servicio_nombre con el nombre exacto o servicio_id.',
    }),
  };
}

async function contextoNegocio(): Promise<{
  nombre: string;
  cierres: string | null;
  diasQueNoAbre: string | null;
  horarios: string | null;
  tono: string;
}> {
  // El orden de la desestructuracion tiene que CALCAR con el del arreglo. Antes
  // quedaron cruzados y `cerrados` recibia el tono: `(cerrados ?? []).filter` tiraba
  // TypeError y TODOS los mensajes del bot caian en el mensaje de falla.
  const [{ data: conf }, { data: cerrados }, { data: tonoConf }, { data: horarios }] = await Promise.all([
    sb.from('configuracion').select('valor').eq('clave', 'nombre_negocio').maybeSingle(),
    sb.from('dias_cerrados').select('fecha, fecha_hasta, motivo').gte('fecha', new Date().toISOString().slice(0, 10)),
    sb.from('configuracion').select('valor').eq('clave', 'tono').maybeSingle(),
    sb.from('horarios_atencion')
      .select('dia_semana, hora_inicio, hora_fin, activo')
      .eq('activo', true)
      .order('dia_semana')
      .order('hora_inicio'),
  ]);

  const nombre = conf?.valor || 'el lavadero';

  // Los dias de la semana sin horario de atencion. Es el dato que le faltaba al
  // modelo: la tabla de fechas dice "domingo 25", no dice que el local no abre
  // los domingos, y por eso ofrecia el domingo como alternativa varias vezes.
  const abiertos = new Set((horarios ?? []).map((h: any) => h.dia_semana));
  const sinAbrir = DIAS_SEMANA.filter((_, i) => !abiertos.has(i));
  const diasQueNoAbre = sinAbrir.length ? sinAbrir.join(', ') : null;
  // Los horarios viajan en la parte variable: el bot ya los tiene para el primer
  // mensaje y no gasta una tool (ni una vuelta) en buscarlos.
  const horariosTexto = horariosDeAtencion(horarios ?? []);

  const proximos = (cerrados ?? [])
    .filter((c: any) => new Date(c.fecha + 'T00:00:00').getTime() <= Date.now() + 1000 * 60 * 60 * 24 * 30)
    .sort((a: any, b: any) => a.fecha.localeCompare(b.fecha));

  const tono = TONOS[(tonoConf?.valor ?? '').trim()] || TONOS.informal;

  if (proximos.length === 0) return { nombre, cierres: null, diasQueNoAbre, horarios: horariosTexto, tono };

  const frases = proximos.slice(0, 2).map((c: any) => {
    const d = new Date(c.fecha + 'T00:00:00');
    const dia = d.getDate();
    const mes = MESES[d.getMonth()];
    const hasta = c.fecha_hasta ? new Date(c.fecha_hasta + 'T00:00:00') : null;
    const motivo = c.motivo ? ` (${c.motivo.toLowerCase()})` : '';
    if (hasta && c.fecha_hasta !== c.fecha) {
      // Rango: "del 2 al 4 de noviembre" (y "del 30 de octubre al 2 de noviembre"
      // si cruza de mes). Antes decia "el 2 de noviembre al 4 de noviembre".
      const mesHasta = MESES[hasta.getMonth()];
      const inicio = mesHasta === mes ? `${dia}` : `${dia} de ${mes}`;
      return `del ${inicio} al ${hasta.getDate()} de ${mesHasta} no trabajamos${motivo}`;
    }
    return `el ${dia} de ${mes} no trabajamos${motivo}`;
  });

  return {
    nombre,
    tono,
    diasQueNoAbre,
    horarios: horariosTexto,
    // Sin el "recordale que" adelante: el prompt ya dice "y avisale que ...", y
    // quedaba "avisale que recordale que el 24 ...".
    cierres: frases.join(' y '),
  };
}

type Bloque = { inicio: number; fin: number };

/** Últimos 10 dígitos: con o sin el 9 y el 54 de adelante, el número es el mismo. */
function ultimosDigitos(t: string): string {
  return (t ?? '').replace(/\D/g, '').slice(-10);
}

// Postgres devuelve las horas como '12:00:00'. Para decírselas a una persona alcanza
// con '12:00'.
function sinSeg(h: string): string {
  return h.slice(0, 5);
}

function sePisan(a: Bloque, b: Bloque): boolean {
  return a.inicio < b.fin && b.inicio < a.fin;
}

// ─── Como esta el dia empleado por empleado ───
// Devuelve, para cada franja, quien puede tomar el turno. Si nadie esta libre en una
// franja, el horario no se ofrece: asi el bot nunca agenda a alguien que ya esta ocupado.
//
// OJO con la jornada: un empleado ACTIVO puede igual no labrar un dia concreto, y a
// veces con un tope de horas (Esteban, por ejemplo, no trabaja los miercoles y los
// sabados corta a las 13). Antes solo se miraba `activo`, asi que el bot le agendo
// un miercoles a las 19 y le dijo que lo atendia Esteban, que no estaba ese dia.
/**
 * El tramo del negocio en el que labra ese empleado ese día, YA recortado por su
 * jornada.
 *
 * El tope de la jornada recorta el horario del negocio: si labra hasta las 13 y el
 * negocio cierra a las 20, a ese empleado lo ven hasta las 13. Por eso hay que
 * intersectar los dos y no usar solo el horario de atención.
 *
 * Varía en "" si no labra ese día. El que decide si eso es "no trabaja" o "no tiene
 * jornada cargada" lo mira el que llama, porque cada tool lo reporta distinto.
 */
function tramoDelDia(
  e: { jornada?: any },
  diaSemana: number,
  horarios: Array<{ hora_inicio: string; hora_fin: string }>
): string {
  const j = Array.isArray(e.jornada) ? e.jornada[diaSemana] : null;
  if (j === null || j === undefined || !j.activo) return '';
  return horarios
    .map((h) => ({
      desde: Math.max(horaAMin(h.hora_inicio), j.hora_inicio ? horaAMin(j.hora_inicio) : 0),
      hasta: Math.min(horaAMin(h.hora_fin), j.hora_fin ? horaAMin(j.hora_fin) : 24 * 60),
    }))
    .filter((t) => t.hasta > t.desde)
    .map((t) => `${minAHora(t.desde)} a ${minAHora(t.hasta)}`)
    .join(' y ');
}

/**
 * Las ausencias que cubren una fecha, incluidas las de UN solo dia.
 *
 * OJO con `hasta`: el panel guarda una ausencia de un dia con `desde` = ese dia y
 * `hasta` = NULL. La migracion 007 lo permite a proposito (`hasta IS NULL OR
 * hasta >= desde`). Con un `.gte('hasta', fecha)` pelado, Postgres DESCARTA esas
 * filas: en SQL, `NULL >= fecha` no es verdadero, es NULL, y el WHERE las deja
 * afuera. El bot las ignoraba y contaba como presente a alguien que estaba
 * ausente.
 *
 * Las ausencias de varios dias (con `hasta` cargado) si funcionaban, y por eso
 * el bug no aparecia probando con un rango: hay que probar con una de un dia,
 * que es justo la que crea el boton del panel.
 */
function ausenciasQueCubren(fecha: string) {
  return sb
    .from('ausencias')
    .select('empleado_id, motivo, hora_inicio, hora_fin')
    .lte('desde', fecha)
    .or(`hasta.gte.${fecha},hasta.is.null`);
}

async function estadoDelDia(fecha: string, excluirTurnoId?: number) {
  const diaSemana = new Date(fecha + 'T00:00:00').getDay();
  const [{ data: empleados }, { data: turnos }, { data: ausencias }] = await Promise.all([
    sb.from('empleados').select('id, nombre, jornada').eq('activo', true).order('nombre'),
    sb.from('turnos')
      .select('id, hora_inicio, hora_fin, duracion_minutos, empleado_id')
      .eq('fecha', fecha)
      .neq('estado', 'cancelado'),
    ausenciasQueCubren(fecha),
  ]);

  const todos = empleados ?? [];

  // ─── Quien labra ese dia, y hasta que hora ───
  // `jornada` es un array de 7 en orden domingo..sabado. Si no tiene jornada
  // cargada se lo trata como que labra todos los dias a todo horario, que es como
  // viene el empleado desde antes de que exista la jornada.
  const labora = new Map<number, { desde: number; hasta: number } | null>();
  for (const e of todos as Array<{ id: number; jornada?: any }>) {
    const j = Array.isArray(e.jornada) ? e.jornada[diaSemana] : null;
    if (j === null || j === undefined) {
      labora.set(e.id, null); // sin dato: disponible todo el dia
      continue;
    }
    if (!j.activo) {
      labora.set(e.id, false as any); // ese dia no trabaja
      continue;
    }
    labora.set(e.id, {
      desde: j.hora_inicio ? horaAMin(j.hora_inicio) : 0,
      hasta: j.hora_fin ? horaAMin(j.hora_fin) : 24 * 60,
    });
  }
  const disponibles = todos.filter((e: any) => labora.get(e.id) !== false);

  // Un turno sin hora_fin (los viejos del bot) cae a hora_inicio + duracion.
  const agenda = new Map<number, Bloque[]>();
  for (const t of turnos ?? []) {
    if (!t.empleado_id) continue;
    // Al reprogramar, el turno que se esta moviendo sigue apuntando a la hora vieja.
    // Si no se lo saca, se cuenta a si mismo como ocupado y no hay forma de moverlo
    // a un horario que se pise con el propio.
    if (excluirTurnoId != null && t.id === excluirTurnoId) continue;
    const inicio = horaAMin(t.hora_inicio ?? '00:00');
    const fin = t.hora_fin ? horaAMin(t.hora_fin) : inicio + (t.duracion_minutos || 30);
    const lista = agenda.get(t.empleado_id) ?? [];
    lista.push({ inicio, fin });
    agenda.set(t.empleado_id, lista);
  }

  // Las ausencias sin horario son el dia entero.
  for (const a of ausencias ?? []) {
    if (!a.empleado_id) continue;
    const bloque: Bloque = {
      inicio: horaAMin(a.hora_inicio ?? '00:00'),
      fin: horaAMin(a.hora_fin ?? '23:59'),
    };
    const lista = agenda.get(a.empleado_id) ?? [];
    lista.push(bloque);
    agenda.set(a.empleado_id, lista);
  }

  // Que este libre ademas de la jornada: si el empleado no labra ese dia, o corta
  // antes de que termine el turno, no puede tomarlo.
  const libres = (empleadoId: number, desde: number, hasta: number): boolean => {
    const j = labora.get(empleadoId);
    if (j === false) return false;
    if (j && (desde < j.desde || hasta > j.hasta)) return false;
    return !(agenda.get(empleadoId) ?? []).some((b) => sePisan({ inicio: desde, fin: hasta }, b));
  };

  return {
    empleados: disponibles,
    todos,
    libres,
    // Por que no puede: el dia que no labra y el horario ocupado son dos cosas
    // distintas y el modelo las mezclaba ("ya hay un turno a esa hora" para un
    // empleado que no trabaja ese dia). Se le da la causa exacta.
    motivoNoPuede: (empleadoId: number): 'no_labora_ese_dia' | 'ocupado' | 'fuera_de_jornada' | null => {
      const j = labora.get(empleadoId);
      if (j === false) return 'no_labora_ese_dia';
      if (j === null || j === undefined) return null;
      return libres(empleadoId, j.desde, j.desde + 1) ? 'fuera_de_jornada' : 'ocupado';
    },
    algunoLibre: (desde: number, hasta: number) => disponibles.some((e: any) => libres(e.id, desde, hasta)),
    // el primero que puede tomar ese horario, o null si esta todo lleno
    quienPuede: (desde: number, hasta: number, preferido?: number | null) => {
      if (preferido != null) return libres(preferido, desde, hasta) ? preferido : null;
      const otro = disponibles.find((e: any) => libres(e.id, desde, hasta));
      return otro ? otro.id : null;
    },
  };
}

/**
 * Los proximos dias en los que el local abre Y hay lugar, ya comprobados.
 *
 * Se usa cuando el dia que pidio el cliente esta cerrado (por `dias_cerrados` o
 * porque ese dia de la semana no abre). Sin esto el modelo nombraba dias "de
 * memoria": en test ofrecio el domingo en un local que no abre los domingos,
 * porque la unica instruccion que tenia era "ofrece otro dia" y la tabla de
 * fechas no dice en que dias abre el local.
 *
 * Devuelve fecha, nombre del dia y una hora concreta libre, para que la oferta
 * sea sobre datos y no sobre una suposicion.
 */
async function diasAbiertosCercanos(
  cerrados: Array<{ fecha: string; fecha_hasta?: string | null }>,
  desdeFecha: string,
  duracion: number,
  limite = 3,
): Promise<Array<{ fecha: string; dia: string; hora: string }>> {
  const salida: Array<{ fecha: string; dia: string; hora: string }> = [];
  const base = new Date(desdeFecha + 'T00:00:00');

  for (let salto = 1; salto <= 14 && salida.length < limite; salto++) {
    const f = new Date(base.getTime());
    f.setDate(f.getDate() + salto);
    const iso = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
    if (diaCerrado(cerrados, iso)) continue;

    const dow = f.getDay();
    const { data: hs } = await sb
      .from('horarios_atencion')
      .select('hora_inicio, hora_fin')
      .eq('dia_semana', dow)
      .eq('activo', true)
      .order('hora_inicio', { ascending: true });
    if (!hs || hs.length === 0) continue;

    const ag = await estadoDelDia(iso);
    const bloque = (hs as Array<{ hora_inicio: string; hora_fin: string }>).find(
      (h) => horaAMin(h.hora_inicio) + duracion <= horaAMin(h.hora_fin),
    );
    if (!bloque) continue;

    const desde = horaAMin(bloque.hora_inicio);
    if (!ag.algunoLibre(desde, desde + duracion)) continue;
    salida.push({ fecha: iso, dia: DIAS_SEMANA[dow], hora: minAHora(desde) });
  }

  return salida;
}

/**
 * El cierre mas cercano a una fecha (hasta 3 dias antes o despues), para
 * avisarlo cuando el cliente reserva o pregunta justo al lado.
 *
 * Va en el resultado de la tool y no solo en el prompt: pedirle al modelo
 * "recordalo" funcionaba a veces y a veces no (se probo: reservo el viernes 23
 * con el local cerrado el sabado 24 y no dijo nada). Con el dato delante de la
 * confirmacion, no depende de que se acuerde.
 */
function cierreCerca(
  cerrados: Array<{ fecha: string; fecha_hasta?: string | null; motivo?: string | null }>,
  fecha: string,
): { fecha: string; motivo: string | null; detalle: string } | null {
  const base = new Date(fecha + 'T00:00:00').getTime();
  let mejor: { fecha: string; motivo: string | null; detalle: string; dist: number } | null = null;

  for (let salto = -3; salto <= 3; salto++) {
    if (salto === 0) continue; // ese mismo dia ya se rechaza aparte
    const f = new Date(base);
    f.setDate(f.getDate() + salto);
    const iso = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
    const c = cierreQueCubre(cerrados, iso);
    if (!c) continue;
    const dist = Math.abs(salto);
    if (!mejor || dist < mejor.dist) {
      mejor = { fecha: iso, motivo: c.motivo ?? null, detalle: detalleCerrado(c), dist };
    }
  }

  return mejor ? { fecha: mejor.fecha, motivo: mejor.motivo, detalle: mejor.detalle } : null;
}

// ─── Ejecutar la tool que eligio el modelo ───
async function ejecutarTool(nombre: string, input: any, telefono: string): Promise<string> {
  switch (nombre) {
    case 'buscar_cliente': {
      // El numero de WhatsApp nunca coincide exacto con el guardado: uno tiene el 9 y el
      // otro no. El RPC `buscar_cliente_por_telefono` compara los ultimos 10 digitos.
      const { data, error } = await sb.rpc('buscar_cliente_por_telefono', { p_telefono: telefono });
      if (error) return err('error_buscando_cliente', error.message);
      const c = (data ?? [])[0];
      if (!c) return JSON.stringify({ ok: true, encontrado: false, nombre: null });
      return JSON.stringify({ ok: true, encontrado: true, id: c.id, nombre: c.nombre, telefono: c.telefono });
    }
    case 'obtener_config_negocio': {
      // Claves que viven en tablas propias, no en `configuracion`.
      if (input.clave === 'horario_atencion') {
        const { data } = await sb
          .from('horarios_atencion')
          .select('dia_semana, hora_inicio, hora_fin, activo')
          .eq('activo', true)
          .order('dia_semana', { ascending: true })
          .order('hora_inicio', { ascending: true });
        // Un dia puede tener MAS DE UN rango: 08:00 a 12:00 y 14:00 a 20:00.
        // Antes esto devolvia una fila por rango y el modelo leia la primera:
        // "hoy el local cierra a las 12:00", con la tarde entera abierta.
        const dias = [1, 2, 3, 4, 5, 6, 0]
          .map((d) => {
            const rangos = (data ?? [])
              .filter((r: any) => r.dia_semana === d)
              .map((r: any) => [sinSeg(r.hora_inicio), sinSeg(r.hora_fin)]);
            return {
              dia_semana: d,
              rangos,
              texto: rangos.map((r: string[]) => `${r[0]} a ${r[1]}`).join(' y '),
            };
          })
          .filter((d) => d.rangos.length > 0);
        return JSON.stringify({
          ok: true,
          valor: dias,
          nota:
            'Cada dia puede tener MAS DE UN rango (por ejemplo mañana y tarde). ' +
            'Si un dia tiene dos rangos NO cierra al terminar el primero: atiende en los dos. ' +
            'Para decir el horario de un dia, deci TODOS sus rangos ("de 8 a 12 y de 14 a 20"), nunca solo el primero.',
        });
      }
      if (input.clave === 'dias_cerrados') {
        const { data } = await sb.from('dias_cerrados').select('fecha, motivo, fecha_hasta').order('fecha', { ascending: true });
        return JSON.stringify({ ok: true, valor: data ?? [] });
      }
      const { data } = await sb.from('configuracion').select('valor').eq('clave', input.clave).single();

      // Una clave que NO esta cargada tiene que decirselo al modelo con todas las
      // letras. Con `valor: null` a secas el bot lo rellenaba: si la direccion no
      // estaba cargada contesto "preguntá directamente por teléfono o Instagram del
      // local", y el "Instagram" era inventado, de la nada, sin ninguna fuente.
      // La leccion: `null` se lee como "no se", no como "no se y no lo digas".
      if (!data?.valor) {
        return JSON.stringify({
          ok: true,
          valor: null,
          configurado: false,
          detalle: `La clave "${input.clave}" esta VACIA en la base. Decile al cliente que esa informacion todavia no esta cargada. NO la completes, NO le des un valor aproximado y NO le sugieras otro canal (redes, mail, un telefono que no te dieron): no tenes de donde sacarlo.`,
        });
      }
      return JSON.stringify({ ok: true, valor: data.valor, configurado: true });
    }
    case 'listar_servicios': {
      const { data } = await sb.from('servicios').select('id, nombre, duracion_minutos, precio').eq('activo', true).order('nombre');
      return JSON.stringify({
        ok: true,
        servicios: data ?? [],
        // La lista vacía necesita decir POR QUÉ: sin esto el bot seguía el
        // Dialogue como si el cliente no hubiera dicho qué servicio quería y pedía
        // el nombre de un turno que no se podía crear nunca.
        vacio: (data ?? []).length === 0,
        detalle:
          (data ?? []).length === 0
            ? 'No hay servicios cargados. NO le pidas el nombre ni digas que vas a agendar: decile al cliente que todavia no hay servicios disponibles en el local.'
            : null,
      });
    }
    case 'buscar_empleados': {
      const { data: todos } = await sb
        .from('empleados').select('id, nombre, jornada').eq('activo', true).order('nombre');

      const fecha = input.fecha;

      // ─── El nombre que nombro el cliente ───
      //
      // La comparacion la hace ACA, no el modelo. Se lo vio hacer de dos maneras
      // que dan lo mismo y las dos malas: "Laura trabaja aca" con Laura ausente de
      // la lista, y "con Laura si esta disponible" cuando Laura no existe. El
      // modelo tiene la lista a la vista y aun asi la resuelve mal, porque comparar
      // un nombre con una lista es exactamente el tipo de tarea que un LLM hace
      // plausiendo en vez de leyendo.
      //
      // Aca hay una sola respuesta correcta posible y sale de los datos.
      const pedido = String(input.nombre ?? '').trim();
      let nombreResuelto: any = null;
      if (pedido) {
        const limpio = pedido.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
        // Primero nombre o apellido, por si el cliente dijo solo uno de los dos.
        const coincide = (todos ?? []).find((e: any) => {
          const partes = String(e.nombre).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/);
          return partes.includes(limpio) || String(e.nombre).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') === limpio;
        });
        nombreResuelto = coincide
          ? { nombre: pedido, encontrado: true, id: coincide.id, nombre_real: coincide.nombre }
          : {
              nombre: pedido,
              encontrado: false,
              detalle: `${pedido} no trabaja en este local.`,
              quien_si: (todos ?? []).map((e: any) => e.nombre),
            };
      }

      // Sin fecha: la lista completa, como siempre.
      if (!fecha) {
        return JSON.stringify({
          ok: true,
          ...(nombreResuelto ? { nombre_consultado: nombreResuelto } : {}),
          empleados: (todos ?? []).map((e) => ({ id: e.id, nombre: e.nombre })),
        });
      }

      // ─── CON fecha: solo quien labra ese dia ───
      // El bug que arregla esto: el bot ofrecía los cuatro empleados a ciegas y
      // recien cuando el cliente elegía a uno se enteraba de que ese día no labraba
      // ("Esteban no trabaja los miércoles"), con lo que le había concedido algo que
      // tenía que deshacer. O sea, ofrecerle una lista que la base ya sabe que es falsa.
      const { data: cerrados } = await sb.from('dias_cerrados').select('fecha, fecha_hasta, motivo');
      const cierreDia = cierreQueCubre(cerrados ?? [], fecha);
      if (cierreDia) {
        return JSON.stringify({ ok: false, error: 'dia_cerrado', motivo: cierreDia.motivo ?? null, detalle: detalleCerrado(cierreDia) });
      }

      const diaSemana = new Date(fecha + 'T00:00:00').getDay();
      const { data: horarios } = await sb
        .from('horarios_atencion').select('hora_inicio, hora_fin')
        .eq('dia_semana', diaSemana).eq('activo', true).order('hora_inicio', { ascending: true });

      // Un dia sin horario de atencion es un dia que el local NO ABRE. No es que
      // falte el horario de un empleado.
      //
      // Antes no se chequeaba, y el domingo la tool contestaba que Martín Acosta
      // estaba "sin horario": el bot lo tradujo a "Martín Acosta no tiene horario
      // asignado", que no es lo que pasa. Lo que pasa es que no se atiende. El
      // empleado tenía su jornada bien cargada para ese día; lo que no existe es el
      // local abierto.
      if (!horarios || horarios.length === 0) {
        // Aun asi va la lista de quienes trabajan en el local. El dia cerrado no
        // significa que no se sepa quienes son: si el cliente pidio a alguien por
        // nombre, hace falta poder decirle "ese nombre no lo tengo aca" en vez de
        // "con Laura si está disponible", que es una manera educada de no
        // responder y dejar al cliente con la duda.
        return JSON.stringify({
          ok: false,
          error: 'dia_sin_atencion',
          detalle: `El ${DIAS_SEMANA[diaSemana].toLowerCase()} el local no abre.`,
          fecha,
          dia: DIAS_SEMANA[diaSemana].toLowerCase(),
          ...(nombreResuelto ? { nombre_consultado: nombreResuelto } : {}),
          // Nadie atiende ese dia, y los nombres que hay son TODOS los que
          // trabajan en el local, para poder responder por un nombre pedido.
          empleados: (todos ?? []).map((e: any) => ({ id: e.id, nombre: e.nombre })),
          nota:
            'Nadie atiende ese dia porque el local esta cerrado. Si el cliente nombro a ' +
            'alguien, decile con esas palabras si ese nombre esta en `empleados` o no, y ' +
            'despues seguí con la propuesta de otro dia. No digas "con X si esta disponible": ' +
            'si no estas en la lista, no trabaja ahi.',
        });
      }

      const { data: ausencias } = await ausenciasQueCubren(fecha);

      const fuera = new Map<number, string>();
      for (const a of ausencias ?? []) {
        if (a.empleado_id) fuera.set(a.empleado_id, a.motivo ?? 'ausente');
      }

      // ─── Si dijeron una hora, distinguir QUIEN TRABAJA de QUIEN ESTA LIBRE ───
      //
      // Son dos preguntas distintas y la tool contestaba solo la primera. El bot decia
      // "a las 15:00 te pueden atender Sofia o Valentina" sin haber consultado ningun
      // horario: la lista que tenia era de quien LABRABA ese dia, que no dice si esta
      // libre a esa hora. Con el dia entero lleno no lo estaba ninguno, y el bot
      // ofrecio las dos.
      //
      // Con `hora` la lista pasa a ser de quien puede TOMAR el turno, que es lo que el
      // cliente esta preguntando cuando dice "con quien a las 15".
      const horaPedida = /^\s*\d{1,2}:\d{2}/.test(String(input.hora ?? ''))
        ? horaAMin(String(input.hora).trim().slice(0, 5))
        : null;
      let duracionHora = 30;
      if (horaPedida != null) {
        const { data: s } = await sb
          .from('servicios').select('duracion_minutos').eq('id', input.servicio_id ?? 1).maybeSingle();
        duracionHora = s?.duracion_minutos || 30;
      }
      const agendaHora = horaPedida != null ? await estadoDelDia(fecha) : null;

      const disponibles: any[] = [];
      const noDisponibles: any[] = [];
      for (const e of todos ?? []) {
        const j = Array.isArray(e.jornada) ? e.jornada[diaSemana] : null;
        if (j === null || j === undefined || !j.activo) {
          noDisponibles.push({ id: e.id, nombre: e.nombre, motivo: 'no trabaja ese dia' });
          continue;
        }
        if (fuera.has(e.id)) {
          noDisponibles.push({ id: e.id, nombre: e.nombre, motivo: `ausente: ${fuera.get(e.id)}` });
          continue;
        }
        disponibles.push({
          id: e.id,
          nombre: e.nombre,
          // El horario de TRABAJO va SOLO cuando se pregunto por una hora concreta y
          // la tool puede decir si ademas esta libre. Si no se pregunto la hora, no
          // viaja.
          //
          // Se saco a proposito: con "Sofia Ramirez (14:00 a 18:00)" a la vista, el
          // bot contestaba "a las 15:00 esta disponible Sofia" sin haber consultado
          // ningun horario. Leia el turno de trabajo como si fuera disponibilidad, que
          // son dos cosas distintas: uno trabaja de 14 a 18 aunque tenga el turno
          // tomado a las 15. Y se vio con el dia entero lleno, offering a dos
          // empleados que no podia atender nadie.
          //
          // Para la pregunta "quien trabaja tal dia", que no es de turnos, esta
          // `empleados_del_dia`, que si devuelve los horarios.
          ...(horaPedida != null ? { horario: tramoDelDia(e, diaSemana, horarios ?? []) || 'sin horario' } : {}),
        });
        // Labra el dia, pero puede estar tomado a esa hora. Va a `no_disponibles`
        // con su motivo, nunca a `empleados`.
        if (agendaHora && !agendaHora.libres(e.id, horaPedida!, horaPedida! + duracionHora)) {
          disponibles.pop();
          noDisponibles.push({
            id: e.id,
            nombre: e.nombre,
            motivo: `trabaja ese dia pero esta ocupado a las ${String(input.hora).trim().slice(0, 5)}`,
          });
        }
      }

      return JSON.stringify({
        ok: true,
        fecha,
        dia: DIAS_SEMANA[diaSemana],
        ...(nombreResuelto ? { nombre_consultado: nombreResuelto } : {}),
        empleados: disponibles,
        no_disponibles: noDisponibles,
        nota:
          'La lista YA viene filtrada por quien trabaja ese dia. Si el cliente pidio uno que NO esta en `empleados`, ' +
          'decile el `motivo` de `no_disponibles` y ofrece los que si: no le ofrezcas como equivalente a alguien que no puede. ' +
          'Si el cliente nombro a alguien y viene en `nombre_consultado` con encontrado:false, ese nombre NO trabaja aca: ' +
          'deciselo con `detalle`, sin suavizar y sin decir "si esta disponible". ' +
          'Si `empleados` viene VACIO y no le pasaste `hora`, no le digas que no puede ninguno: significa que solo se filtro por dia. ' +
          'Si le pasaste `hora` y esta vacio, entonces a esa hora no puede ninguno, y eso hay que decirlo. ' +
          'Si NO le pasaste `hora`, esta lista es de quien TRABAJA ese dia y nada mas: no te dice que esten libres a ninguna hora. ' +
          'Nunca digas "a tal hora puede atenderte fulano" con esta lista. Para eso, consultar_horarios_libres.',
      });
    }
    case 'empleados_del_dia': {
      // "quien trabaja el jueves" es una pregunta de gente, no de turnos. Antes el
      // bot reconducía todo a "¿que servicio?" y el clienteGBA loop hasta que
      // aceptaba elegir uno, cuando la pregunta no tiene nada que ver con servicios.
      const fecha = input.fecha;
      const { data: cerrados } = await sb.from('dias_cerrados').select('fecha, fecha_hasta, motivo');
      const cierreDia = cierreQueCubre(cerrados ?? [], fecha);
      if (cierreDia) {
        return JSON.stringify({ ok: false, error: 'dia_cerrado', motivo: cierreDia.motivo ?? null, detalle: detalleCerrado(cierreDia) });
      }

      const diaSemana = new Date(fecha + 'T00:00:00').getDay();
      const { data: horarios } = await sb
        .from('horarios_atencion')
        .select('hora_inicio, hora_fin')
        .eq('dia_semana', diaSemana)
        .eq('activo', true)
        .order('hora_inicio', { ascending: true });
      if (!horarios || horarios.length === 0) {
        return JSON.stringify({ ok: false, error: 'no_atiende', detalle: 'Ese dia el negocio no atiende.' });
      }

      const { data: empleados } = await sb
        .from('empleados')
        .select('id, nombre, jornada')
        .eq('activo', true)
        .order('nombre');

      const { data: ausencias } = await ausenciasQueCubren(fecha);

      const fuera = new Map<number, string>();
      for (const a of ausencias ?? []) {
        if (a.empleado_id) fuera.set(a.empleado_id, a.motivo ?? 'ausente');
      }

      const lista = [];
      const ausentes = [];
      for (const e of empleados ?? []) {
        const j = Array.isArray(e.jornada) ? e.jornada[diaSemana] : null;
        if (j === null || j === undefined || !j.activo) {
          ausentes.push(e.nombre);
          continue;
        }
        if (fuera.has(e.id)) {
          ausentes.push(e.nombre);
          continue;
        }
        // El tope de la jornada recorta el horario del negocio: si labra hasta las 13
        // y el negocio cierra a las 20, a este empleado lo ven hasta las 13. Vive en
        // `tramoDelDia`, que comparte con `buscar_empleados`.
        const tramo = tramoDelDia(e, diaSemana, horarios ?? []);

        lista.push({ id: e.id, nombre: e.nombre, horario: tramo || 'sin horario' });
      }

      return JSON.stringify({
        ok: true,
        fecha,
        dia: ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][diaSemana],
        Atencion: (horarios as any[]).map((h) => `${sinSeg(h.hora_inicio)} a ${sinSeg(h.hora_fin)}`).join(' y '),
        empleados: lista,
        ausentes,
      });
    }
    case 'asociar_numero': {
      // El cliente confirmo que es la misma persona que ya esta con otro numero.
      const clienteId = Number(input.cliente_id);
      const { data: cliente } = await sb.from('clientes').select('id, nombre').eq('id', clienteId).maybeSingle();
      if (!cliente) return err('cliente_no_encontrado');
      const { data: existe } = await sb
        .from('telefonos')
        .select('id')
        .eq('telefono', telefono)
        .maybeSingle();
      if (existe) {
        await sb.from('telefonos').update({ cliente_id: clienteId, principal: false }).eq('id', existe.id);
        return JSON.stringify({ ok: true, cliente_id: clienteId, nombre: cliente.nombre });
      }
      const { error } = await sb
        .from('telefonos')
        .insert({ cliente_id: clienteId, telefono, principal: false });
      if (error) return err('error_asociando_numero', error.message);
      return JSON.stringify({ ok: true, cliente_id: clienteId, nombre: cliente.nombre });
    }
    case 'consultar_horarios_libres': {
      const fecha = input.fecha;

      // ─── Los turnos del MISMO cliente en esa fecha ───
      // Esto es lo que hace dar tantas vueltas cuando un cliente quiere varios
      // servicios. El bot agendo el primero, ofrecio el segundo a una hora que en
      // realidad se le pisaba con el primero, y asi fue Enterando de a un conflicto
      // por mensaje: primero que no entra antes del cierre, despues que ya hay turno,
      // despues que el empleado cambia...
      //
      // La causa NO es que el bot sea lento: es que `alguienLibre` solo mira la
      // agenda de los EMPLEADOS. Para un cliente que ya tiene un turno de 16:00 a
      // 18:30, las 17:30 estan libres para la empleada pero no para ESTE cliente, y
      // la tool las ofrecia igual. El modelo se enteraba recien al agendar.
      //
      // Por eso la exclusion va ACA: los horarios que le salen al modelo ya no
      // incluyen los que se pisan con lo que el cliente tiene. No alcanza con pedirle
      // que no ofrezca horas sin chequear, porque la tool le estaba dando horas
      // imposibles como si fueran libres.
      const { data: yo } = await sb.rpc('buscar_cliente_por_telefono', { p_telefono: telefono });
      const miId = (yo ?? [])[0]?.id ?? null;
      const { data: mios } = miId != null
        ? await sb
            .from('turnos')
            .select('id, hora_inicio, hora_fin, servicio_nombre')
            .eq('cliente_id', miId)
            .eq('fecha', fecha)
            .neq('estado', 'cancelado')
        : { data: [] as any[] };

      const misTurnos = (mios ?? []).map((t: any) => ({
        hora_inicio: sinSeg(String(t.hora_inicio ?? '00:00')),
        hora_fin: sinSeg(String(t.hora_fin ?? '00:00')),
        servicio: t.servicio_nombre,
      }));

      /** ¿Este tramo se pisa con algo que el cliente ya tiene? */
      const pisaConLosSuyos = (a: number, b: number): boolean =>
        (mios ?? []).some((t: any) => {
          const ta = horaAMin(String(t.hora_inicio ?? '00:00').slice(0, 5));
          const tb = horaAMin(String(t.hora_fin ?? '00:00').slice(0, 5));
          return ta < b && a < tb;
        });
      // 0. La duracion la manda el servicio, no un slot fijo de 30 min. Va ANTES
      // de los chequeos de dia cerrado porque los dias alternativos que se
      // devuelven cuando el dia esta cerrado tambien dependen de la duracion.
      const resServ = await resolverServicio(input);
      if (!resServ.ok) return resServ.respuesta;
      const serv = resServ.servicio;
      const duracion = serv?.duracion_minutos || 30;

      // 1. cerrado? (`fecha` es el inicio, `fecha_hasta` el final; si no hay, fue un día solo)
      const { data: cerrados } = await sb.from('dias_cerrados').select('fecha, fecha_hasta, motivo');
      const cierre = cierreQueCubre(cerrados ?? [], fecha);
      if (cierre) {
        // Los dias de reemplazo ya vienen comprobados. Sin esto el modelo ofrecia
        // "el viernes 23 o el domingo 25" en un local que no abre los domingos:
        // la unica ayuda que tenia era "ofrece otro dia".
        const alternativos = await diasAbiertosCercanos(cerrados ?? [], fecha, duracion);
        return JSON.stringify({
          ok: false,
          error: 'dia_cerrado',
          motivo: cierre.motivo ?? null,
          detalle: detalleCerrado(cierre),
          dias_alternativos: alternativos,
          nota: alternativos.length
            ? 'Ofrecele SOLO los dias de `dias_alternativos`: ya estan comprobados contra la agenda. No nombres otro dia que no venga en la lista.'
            : 'No hay dias cercanos con lugar. Decile cuando reabre y no inventes un dia.',
        });
      }

      // 2. dia de la semana
      const d = new Date(fecha + 'T00:00:00');
      const diaSemana = d.getDay();
      const { data: horarios } = await sb
        .from('horarios_atencion')
        .select('hora_inicio, hora_fin')
        .eq('dia_semana', diaSemana)
        .eq('activo', true)
        .order('hora_inicio', { ascending: true });
      if (!horarios || horarios.length === 0) {
        // No es un cierre cargado: ese dia de la semana el local no abre.
        const alternativos = await diasAbiertosCercanos(cerrados ?? [], fecha, duracion);
        return JSON.stringify({
          ok: false,
          error: 'dia_cerrado',
          motivo: null,
          detalle: `El ${DIAS_SEMANA[diaSemana].toLowerCase()} el local no abre.`,
          dias_alternativos: alternativos,
          nota: alternativos.length
            ? 'Ofrecele SOLO los dias de `dias_alternativos`: ya estan comprobados contra la agenda. No nombres otro dia que no venga en la lista.'
            : 'No hay dias cercanos con lugar. Decile cuando reabre y no inventes un dia.',
        });
      }

      // Un dia puede tener VARIOS bloques: el lavadero abre de 8 a 12 y de 14 a 20.
      // Antes se tomaba solo el primero y el bot daba el mediodía por cierre, saying
      // que a las 14 no se podía aunque la tarde estaba abierta.
      const bloques = (horarios as Array<{ hora_inicio: string; hora_fin: string }>).map((h) => ({
        desde: horaAMin(h.hora_inicio),
        hasta: horaAMin(h.hora_fin),
      }));

      // 3. la duracion ya se leyo arriba (bloque 0), porque los dias cerrados la
      // necesitan para calcular los alternativos.

      // 4. estado del dia, POR EMPLEADO. Un horario esta libre si hay AL MENOS UN
      //    empleado sin nada encima en esa franja: antes se miraba el negocio entero
      //    como un bloque, asi que un turno de uno tapaba los horarios de todos.
      const agenda = await estadoDelDia(fecha);

      // Si el cliente pidio un empleado concreto, la disponibilidad es la DE ESE, no la
      // de cualquiera. `alguien` decide a quien se le pregunta por disponibilidad.
      const pedido = input.empleado_id != null ? Number(input.empleado_id) : null;

      // El nombre se busca entre TODOS los activos, no entre los que labran ese dia.
      // `estadoDelDia` saca de la lista a quien no trabaja el dia (Esteban, por
      // ejemplo, no labra los miercoles), asi que mirando en `empleados` el nombre
      // daba null justo en el caso que mas lo necesita: el bot terminaba culpando a
      // "un turno que ya hay" cuando en realidad ese dia nolabra nadie con ese nombre.
      let nombrePedido = pedido != null
        ? (agenda.todos.find((e: any) => e.id === pedido) ?? null)
        : null;
      if (pedido != null && nombrePedido == null) {
        const { data: e } = await sb.from('empleados').select('id, nombre').eq('id', pedido).maybeSingle();
        nombrePedido = e ?? null;
      }
      const alguien = (a: number, b: number): boolean =>
        pedido != null ? agenda.libres(pedido, a, b) : agenda.algunoLibre(a, b);

      // 5. slots de 15 min que entren COMPLETOS dentro de ALGUN bloque del dia.
      //    El lavadero agenda en cualquier hora (hay turnos a las 08:15 y 08:45), asi
      //    que una grilla de 30 dejaba afuera horarios que el panel si acepta.
      //
      //    Y que NO se pisan con los turnos que el cliente ya tiene ese dia: sin esto
      //    la tool ofrecia al cliente una hora que era libre para el empleado pero
      //    imposible para el, y el conflicto aparecia recien al agendar.
      const libres: number[] = [];
      for (const b of bloques) {
        let cur = b.desde;
        while (cur + duracion <= b.hasta) {
          if (alguien(cur, cur + duracion) && !pisaConLosSuyos(cur, cur + duracion) && !libres.includes(cur)) {
            libres.push(cur);
          }
          cur += 15;
        }
      }
      libres.sort((a, b) => a - b);

      // 6. si el cliente dijo a que hora queria, se ordena de mas cerca a mas lejos.
      //    Sin esto el modelo recibia la lista cronologica y elegia cualquiera al azar.
      const pref = input.hora_preferida ? horaAMin(String(input.hora_preferida).slice(0, 5)) : null;

      // La hora exacta que pidio tiene prioridad aunque caiga fuera de la grilla: si
      // entra en el horario y hay alguien libre, se agenda ahi y punto.
      const entraEnAlgunBloque = (t: number) => bloques.some((b) => t >= b.desde && t + duracion <= b.hasta);
      if (pref != null && !libres.includes(pref) && entraEnAlgunBloque(pref) && alguien(pref, pref + duracion)) {
        libres.push(pref);
      }

      const ordenada =
        pref == null
          ? libres
          : [...libres].sort((a, b) => Math.abs(a - pref) - Math.abs(b - pref) || a - b);

      // 7. por que el horario pedido no sirve, si no sirve. Sin esto el bot se inventa una
      //    excusa o dice que esta cerrado cuando en realidad es que no entra el servicio.
      const cabe = pref != null && entraEnAlgunBloque(pref);
      const estaLibre = cabe && alguien(pref, pref + duracion);

      let motivo: string | null = null;
      if (pref != null && !cabe) {
        const ultimoReal = libres.length ? libres.reduce((a, b) => (a > b ? a : b)) : null;
        // El bloque que mas se le acerca, para decirle ESE cierre y no el del primer
        // bloque del dia (que era justo el bug: decia "cerramos a las 12" un lunes
        // que sigue abierto hasta las 20).
        const cercano = bloques.reduce((a, b) =>
          Math.abs(a.desde - pref) <= Math.abs(b.desde - pref) ? a : b
        );
        motivo =
          pref < bloques[0].desde
            ? `Abrimos a las ${minAHora(bloques[0].desde)}.`
            : `Ese servicio dura ${duracion} min y ese tramo cierra a las ${minAHora(cercano.hasta)}, asi que a las ${minAHora(pref)} se pasaria.` +
              (ultimoReal != null ? ` El ultimo horario posible es las ${minAHora(ultimoReal)}.` : ' Ese dia no entra.');
      } else if (pref != null && !estaLibre) {
        // Con `empleado_id` hay tres motivos distintos y se confundian entre si:
        // un empleado que no labra ese dia salia como "ya hay un turno a esa hora",
        // que es falso. `estadoDelDia` ya sabe cual de los tres es.
        if (pedido != null) {
          const nombre = nombrePedido?.nombre ?? `el empleado ${pedido}`;
          const causa = agenda.motivoNoPuede(pedido);
          motivo =
            causa === 'no_labora_ese_dia'
              ? `${nombre} no trabaja ese dia.`
              : causa === 'fuera_de_jornada'
                ? `${nombre} no termina de trabajar a esa hora.`
                : `${nombre} ya tiene un turno a esa hora.`;
        } else {
          motivo = 'A esa hora ya hay un turno.';
        }
      }

      const ultimoSlot = libres.length ? libres.reduce((a, b) => (a > b ? a : b)) : null;

      // ─── Dias alternativos YA COMPROBADOS ───
      //
      // Cuando el cliente pide un dia/hora y no se puede, la pregunta siguiente siempre
      // es "y que dias hay?". El modelo la contestaba nombrando dias sueltos y sin
      // consultar: "te puedo ofrecer el martes 20, el miercoles 21 o el jueves 22",
      // tres dias y cero llamadas. Salian bien de casualidad, y en un local con la
      // semana llena se le dabamos al cliente un dia tomado como si estuviera libre.
      //
      // Como no es confiable que consulte uno por uno, se calculan ACA, uno por uno,
      // contra la misma agenda y con el mismo criterio que esta misma tool. El modelo
      // solo los anuncia.
      const diasAlternativos: any[] = [];
      if (!estaLibre && pref != null) {
        for (let salto = 1; salto <= 10 && diasAlternativos.length < 3; salto++) {
          const f = new Date(d.getTime());
          f.setDate(f.getDate() + salto);
          const iso = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
          if (diaCerrado(cerrados ?? [], iso)) continue;
          const dow = new Date(iso + 'T00:00:00').getDay();
          const { data: hs } = await sb
            .from('horarios_atencion').select('hora_inicio, hora_fin')
            .eq('dia_semana', dow).eq('activo', true);
          if (!hs || hs.length === 0) continue;
          const ag = await estadoDelDia(iso);
          // `pref` ya esta en minutos (ver arriba), no es un "HH:MM": pasarle por horaAMin
// revienta con "hhmm.split is not a function".
          const desde = pref;
          const hasta = desde + duracion;
          const entra = (hs as Array<{ hora_inicio: string; hora_fin: string }>).some(
            (h) => desde >= horaAMin(h.hora_inicio) && hasta <= horaAMin(h.hora_fin),
          );
          if (!entra) continue;
          if (!ag.algunoLibre(desde, hasta)) continue;
          diasAlternativos.push({ fecha: iso, dia: DIAS_SEMANA[dow], hora: minAHora(pref) });
        }
      }

      // ─── Sugerencias numeradas ───
      // `ordenada` ya viene de mas cerca a mas lejos cuando el cliente dijo hora, asi
      // que esto es solo la misma lista, con numero y con la distancia. Sin los
      // numeros el modelo armaba la oferta a mano y de un mensaje al otro proponia
      // horarios distintos para el mismo caso; con ellos, el "dale" del cliente
      // apunta a un numero concreto.
      //
      // Se ofrecen UNO antes y otro despues de la hora pedida: al cliente que le
      // fallan las 10 le sirve saber que tiene 10:15 y 9:45, no solo una.
      //
      // ─── POR QUE LA LISTA VIENE CORTADA ───
      // Antes `libres` devolvía los 32 horarios del día y el modelo los volcaba
      // todos: "14:45, 15:00, 15:15, 15:30, ... 19:00", dieciocho en un mensaje. Es
      // más largo que el problema que está resolviendo, y el cliente tiene que leer
      // para encontrar dos horarios que le sirvan.
      //
      // El corte es acá y no en el prompt porque el prompt es una recomendación y
      // una recomendación se cumple la mitad de las veces: la lista larga ya estaba
      // en el contexto y el modelo la tenía a mano. Con la lista corta, la
      // herramienta le da lo que tiene que decir y nada más.
      const pedidos = Number(input.cantidad ?? 3) || 3;
      const cantidad = Math.max(1, Math.min(10, pedidos));

      const sugerencias = ordenada.slice(0, cantidad).map((h, i) => ({
        opcion: i + 1,
        hora: minAHora(h),
        corre_minutos: pref == null ? null : h - pref,
      }));

      // ─── Quien atiende: NO va en la propuesta ───
      //
      // Antes esta respuesta traia "quien_puede_atender" y el bot lo decia al
      // proponer ("te puede atender Sofia o Valentina"), o directamente preguntaba
      // "a quien preferis". El cliente terminaba eligiendo empleado antes de tener
      // el turno, y al que no le importaba igual le comia un mensaje de ida y
      // vuelta. La propuesta va con dia, hora y servicio, nada mas: crear_turno
      // asigna a quien este libre y el nombre aparece recien en la confirmacion,
      // con el empleado_nombre que devuelve la tool. Si el cliente pide a alguien
      // concreto, buscar_empleados CON LA FECHA se lo dice y se le pasa el id.
      const horasOrdenadas = ordenada.slice(0, cantidad);
      return JSON.stringify({
        ok: true,
        libres: horasOrdenadas.map(minAHora),
        total_libres: ordenada.length,
        hay_mas: ordenada.length > cantidad,
        sugerencias,
        // Lo que el cliente YA tiene ese dia. Se devuelve para que el bot pueda
        // explicar por que una hora que el pidio no aparece, en lugar de quedarse
        // mirando una lista mas corta sin entender que paso.
        turnos_del_cliente: misTurnos,
        // Que proponer cuando la hora pedida no se puede. Va calculada aca y no
        // dejada al modelo: es la misma que crear_turno va a elegir cuando el
        // cliente acepte, asi que el "dale" cae en el horario que le dijimos.
        recomendada: pref != null && !estaLibre ? (sugerencias[0]?.hora ?? null) : null,
        // Dias ya comprobados con lugar a ESA misma hora, cuando el pedido no se pudo.
        // Vienen vacios si el dia/hora si se pudo, o si no hay nada libre en los
        // proximos dias: en ese caso no hay nada que ofrecer y hay que decirlo.
        dias_alternativos: diasAlternativos,
        // Quien atiende no viaja aca a proposito: ver el comentario de arriba.
        dia: fecha,
        // Cierre a 3 dias o menos de la fecha consultada. Va con la respuesta
        // para que el aviso salga cuando el cliente esta por reservar al lado, no
        // como una instruccion suelta que el modelo puede saltear.
        cierre_cerca: cierreCerca(cerrados ?? [], fecha),
        nota_cierre:
          'Si cierre_cerca no es null, cuando le propongas el turno sumale UNA frase corta ' +
          'avisando que ese dia el local no trabaja y por que (el motivo esta en detalle).',
        duracion_minutos: duracion,
        horario_pedido: pref != null ? minAHora(pref) : null,
        pedido_disponible: pref == null ? null : estaLibre,
        motivo_pedido: motivo,
        ultimo_horario: ultimoSlot != null ? minAHora(ultimoSlot) : null,
        nota: pref != null
          ? 'La lista viene ordenada de la hora que pidio el cliente hacia atras. Ofrecele las 3 primeras de `sugerencias`, con su numero de opcion, y arrancá por la recomendada.'
          : 'Ordenadas por hora de apertura. Ofrecele las 3 primeras de `sugerencias`.',
        aviso:
          'LOS UNICOS HORARIOS LIBRES SON LOS DE `libres` Y `sugerencias`. Los que no aparecen ahí, NO están. ' +
          'No saques horarios libres de ningún otro dato: que el local abra de 14:00 a 20:00 NO significa que haya lugar a las 14:00, ' +
          'significa nada sobre la disponibilidad. Si el cliente pide una franja y en `libres` no hay nada de esa franja, el día está lleno ' +
          'en esa franja: decilo así y ofrecé otro día, no inventes una hora.',
        // Esto se lee aunque el modelo no lea la `nota`: la lista ya viene corta y
        // `hay_mas` le dice que puede pedir más si el cliente insiste.
        maxima_a_ofrecer: cantidad,
        empleado_filtrado: nombrePedido ? nombrePedido.nombre : null,
      });
    }
    case 'crear_turno': {
      const { nombre_cliente, fecha_hora, empleado_id } = input;
      // 0. resolver el cliente por numero. Si ya existe se usa su nombre de la base y no
      //    hace falta que el modelo lo haya preguntado. Si no, se crea con el nombre dado.
      const { data: yaExiste } = await sb.rpc('buscar_cliente_por_telefono', { p_telefono: telefono });
      const previo = (yaExiste ?? [])[0];

      // El nombre del turno NO es siempre el del que escribe: la clienta saca turno
      // para una amiga, el padre para el hijo. Cuando el modelo manda nombre_cliente,
      // ese nombre GANA sobre el de la ficha. Antes era `previo?.nombre ?? nombre_cliente`
      // y el turno quedaba a nombre del que escribio: se vio en produccion, el bot
      // confirmo "el turno de Lilian" y en la base decia "Mirta de Aguero".
      const nombreDado = typeof nombre_cliente === 'string' ? nombre_cliente.trim() : '';
      if (!previo && !nombreDado) return err('falta_nombre', 'El cliente es nuevo y no dijo su nombre.');
      let nombreFinal = nombreDado || previo?.nombre;

      // Nombre distinto al de la ficha = el turno es para otra persona. El telefono
      // del turno sigue siendo el de quien escribe (es quien lo va a mover o
      // cancelar), pero la ficha pasa a ser de quien se atiende.
      const plano = (s: any) =>
        String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
      const esParaOtro = !!nombreDado && !!previo && plano(nombreDado) !== plano(previo.nombre);

      // Nombres de relleno con los que el modelo intenta "pasar" el chequeo para crear
      // el turno antes de preguntar el nombre. Se vio en una prueba: mando
      // nombre_cliente: "Pendiente", creo el turno y recien despues pregunto. Un turno
      // con ese nombre es un turno sin cliente (y los links de calendario ya salieron).
      const DE_RELLENO = new Set([
        'pendiente', 'cliente', 'clienta', 'cliente nuevo', 'cliente nueva',
        'sin nombre', 'sin apellido', 'ninguno', 'ninguna', 'anonimo', 'anonima', 'nn', 'n a', 'xxx',
      ]);
      if (nombreDado && DE_RELLENO.has(plano(nombreDado))) {
        return err('falta_nombre', 'No inventes un nombre para completar el turno. Pedile al cliente su nombre y apellido.');
      }

      // ─── Nombre y apellido ───
      //
      // Con un solo nombre no se puede working con el cliente: dos Pamelas son dos
      // personas, y el panel termina con la ficha de una mostrando los turnos de la
      // otra. Ya se vio pasar: la clienta dijo "soy Pamela" y el bot, en vez de
      // pedir el apellido, pregunto "¿sos la misma Pamela que ya tenemos registrada con
      // otro numero?", que deja el problema donde estaba.
      //
      // Se corta acá y no en el prompt, porque el prompt solo no alcanza: es una
      // pregunta que el modelo tiene que acordarse de hacer en el momento justo, y si
      // se olvida, el turno queda guardado a medias. Acá no hay forma de pasar sin
      // apellido.
      //
      // Dos palabras es el minimo. "Ramirez" a secas se acepta: hay gente de un solo
      // apellido, y frenar ahi seria peor que dejar un nombre corto.
      if (nombreDado) {
        const palabras = String(nombreFinal).trim().split(/\s+/).filter(Boolean);
        const soloUnApellido = palabras.length === 1 && /^[A-Za-zÁ-ÿÑñ'-]+$/.test(palabras[0]);
        if (palabras.length < 2 && !soloUnApellido) {
          return err(
            'falta_apellido',
            `El cliente dijo solo "${nombreFinal}". Hay que pedirle el apellido antes de guardar el turno: con un solo nombre no se puede, ` +
            `porque dos personas pueden llamarse igual y el turno queda en la ficha de la otra. ` +
            `Preguntale el apellido en UNA linea corta ("¿Y tu apellido?") y agendar con nombre y apellido.`,
          );
        }
      }
      const clienteId = previo?.id ?? null;

      // ─── Nombre repetido ───
      // `clientes.nombre` tiene indice UNIQUE. Si el numero es nuevo pero el nombre ya
      // existe con OTRO numero, el UPDATE del nombre revienta contra el indice y, si
      // no se mira el error, el turno queda diciendo el nombre del cliente pero
      // apuntando a una ficha "Cliente Nuevo N": el panel nunca lo encuentra y el
      // nombre queda existiendo en dos lugares. Se corta aca y se le pregunta a la
      // persona, que es la unica que sabe si es la misma.
      if (!previo && nombreDado) {
        // Sin acentos: el cliente escribe "Hernan Garcia" y en la base esta
        // "Hernán Garcia". Con la comparacion literal no se cruzaban y el indice
        // unico (que SI distingue mayusculas pero no acentos) terminaba de decides.
        const { data: conEseNombre } = await sb
          .from('clientes')
          .select('id, nombre');
        const mismo = (conEseNombre ?? []).find((h: any) => plano(h.nombre) === plano(nombreFinal));
        if (mismo) {
          const { data: tels } = await sb.from('telefonos').select('telefono').eq('cliente_id', mismo.id);
          const finales = (tels ?? []).map((t: any) => String(t.telefono).slice(-4)).join(', ');
          return JSON.stringify({
            ok: false,
            error: 'nombre_ya_existe',
            cliente_id: mismo.id,
            nombre_existente: mismo.nombre,
            detalle:
              `Ya tenemos a "${mismo.nombre}" con otro numero${finales ? ` (terminado en ${finales})` : ''}. ` +
              `Preguntale al cliente si es la misma persona: si dice que si, llamá asociar_numero con ese cliente_id ` +
              `y segui. Si dice que no, pedile el nombre como lo escribe en el DNI.`,
          });
        }
      }
      // 1. fecha y hora coherentes
      const [fecha, hora] = String(fecha_hora).split('T');
      if (!fecha || !hora || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return err('fecha_invalida', fecha_hora);
      // La hora viene en hora del local: se compara como tal (ver msLocales), no
      // como si fuera UTC, que es tres horas antes de lo que es.
      if (msLocales(fecha, hora) < Date.now()) return err('fuera_de_horario', 'La fecha/hora ya pasaron.');

      // 2. cerrado?
      const { data: cerradosCr } = await sb.from('dias_cerrados').select('fecha, fecha_hasta, motivo');
      const cierreCr = cierreQueCubre(cerradosCr ?? [], fecha);
      if (cierreCr) return err('fuera_de_horario', detalleCerrado(cierreCr));

      // 3. servicio existe (por nombre o por id)
      const resServ = await resolverServicio(input);
      if (!resServ.ok) return resServ.respuesta;
      const serv = resServ.servicio;

      // 4. dentro del horario de atencion, y que el servicio TERMINE antes del cierre
      //    de ALGUN bloque. El dia puede tener varios (8-12 y 14-20): antes se miraba
      //    solo el primero y un turno a las 14 de un lunes se rechazaba como si
      //    cerramos al mediodia.
      const diaSemana = new Date(fecha + 'T00:00:00').getDay();
      const { data: horarios } = await sb
        .from('horarios_atencion')
        .select('hora_inicio, hora_fin')
        .eq('dia_semana', diaSemana)
        .eq('activo', true)
        .order('hora_inicio', { ascending: true });
      if (!horarios || horarios.length === 0) return err('fuera_de_horario', 'Ese dia no atienden.');

      const horaInicio = hora.slice(0, 5);
      const desde = horaAMin(horaInicio);
      const duracion = serv.duracion_minutos;
      const bloques = (horarios as Array<{ hora_inicio: string; hora_fin: string }>).map((h) => ({
        desde: horaAMin(h.hora_inicio),
        hasta: horaAMin(h.hora_fin),
      }));

      // El turno tiene que ENTRAR COMPLETO en algun bloque. Se prueba para cada hora
      // candidata, no solo para la pedida: el cliente que pide 12:30 un dia que cierra
      // a las 12 puede entrar a las 11:30, y con `aceptar_cercania_minutos` lo agenda.
      const entraCompleto = (t: number) => bloques.some((b) => t >= b.desde && t + duracion <= b.hasta);

      // 5. que haya un empleado LIBRE en esa franja. Antes se comparaba solo la hora
      //    exacta de inicio, asi que un lavado de 45 min a las 10:00 no bloqueaba un
      //    turno de 60 min a las 10:30 (se pisaban), y el empleado salia siempre el
      //    primero del abecedario sin mirar si estaba ocupado.
      const agenda = await estadoDelDia(fecha);

      // ─── La hora pedida esta tomada: buscar la mas cercana ───
      // Si el cliente ya acepto que le ofrezcas otra, `aceptar_cercania_minutos` dice
      // hasta cuanto puede correrse. El que elige el horario final es ESTE codigo, no
      // el modelo: si lo eligiera el LLM, un digito mal mandado deja al cliente sin
      // turno o con uno duplicado, y no hay forma de darse cuenta desde afuera.
      //
      // El orden de los candidatos es el que hace que un "dale" caiga en el horario
      // que el bot acaba de proponer: primero el mas cercano y, a igual distancia, el
      // ANTERIOR (10:15 y 9:45 en ese orden, igual que los devuelve `sugerencias`).
      const radio = Math.max(0, Math.min(300, Number(input.aceptar_cercania_minutos ?? 0) || 0));
      const candidatos: number[] = [desde];
      for (let salto = 15; salto <= radio; salto += 15) candidatos.push(desde - salto, desde + salto);

      // Si el turno es para HOY, un candidato puede caer en un horario que YA PASO: el
      // cliente pide las 10:30 siendo las 10:20 y "cerca" hacia atras es las 10:15.
      // Agendar en el pasado es un turno que el panel muestra como perdido.
      //
      // La funcion corre en UTC y el negocio es de Argentina (UTC-3): hay que restar
      // 3 horas antes de preguntar que hora es, o el corte queda 3 horas corrido.
      const ahoraArg = new Date(Date.now() - 3 * 3600 * 1000);
      const minutosAhoraArg = ahoraArg.getUTCHours() * 60 + ahoraArg.getUTCMinutes();
      const esHoy = fecha === ahoraArg.toISOString().slice(0, 10);

      let horaElegida: number | null = null;
      let hastaElegida = desde + duracion;
      let empId: number | null = null;
      for (const c of candidatos) {
        if (c < 0 || (esHoy && c < minutosAhoraArg) || !entraCompleto(c)) continue;
        // Si el cliente dijo QUIEREN a alguien (el modelo paso empleado_id), es
        // EXIGENTE: `quienPuede` devuelve null antes que darle a otro en silencio.
        const quien = agenda.quienPuede(c, c + duracion, empleado_id ?? null);
        if (quien == null) continue;
        horaElegida = c;
        hastaElegida = c + duracion;
        empId = quien;
        break;
      }

      // ─── No hay horario ───
      // Los tres motivos se distinguen porque son tres mensajes distintos para el
      // cliente: "cerramos a las 12" no es lo mismo que "ese dia no labra Juan" ni
      // que "ya hay un turno a esa hora".
      if (empId == null) {
        if (empleado_id != null) {
          const { data: e } = await sb.from('empleados').select('nombre').eq('id', empleado_id).maybeSingle();
          const cerca = radio > 0 ? ` ni en los ${radio} minutos de alrededor` : '';
          return err('empleado_no_disponible', `${e?.nombre ?? 'Ese empleado'} no esta libre a esa hora${cerca}.`);
        }
        if (!entraCompleto(desde)) {
          const texto = horarios
            .map((h: any) => `${sinSeg(h.hora_inicio)} a ${sinSeg(h.hora_fin)}`)
            .join(' y ');
          return err('fuera_de_horario', `Ese dia atendemos de ${texto}. El servicio dura ${serv.duracion_minutos} min.`);
        }
        return err(
          'horario_no_disponible',
          radio > 0
            ? 'Ese horario esta tomado y tampoco hay lugar cerca.'
            : 'Ese horario esta tomado. Ofrecele otro.',
        );
      }

      const horaReservada = minAHora(horaElegida!);
      // Que la hora se haya corrido se devuelve SIEMPRE, aunque el cliente haya pedido
      // el exacto. Sin esto el bot dice "listo, 10:00" y el turno quedo a las 10:15.
      const seCorrio = horaElegida !== desde;

      // ─── El MISMO cliente no puede estar en dos lugares ───
      // El chequeo del empleado no cubre esto: dos clientes distintos pueden estar en
      // el salon a la vez, eso es normal, pero la misma persona en dos turnos que se
      // pisan es un turno imposible.
      //
      // El caso que lo dispara: "quiero un corte de pelo Y un lavado y alisado". Son
      // dos servicios y por lo tanto dos turnos, pero NO pueden empezar los dos a las
      // 14:00. El bot tiene que ofrecer el segundo despues del primero.
      //
      // Va DESPUES de elegir la hora, porque el aviso tiene que decir a que hora
      // choca para que el bot pueda ofrecer otra, y no un "no se puede" seco.
      if (clienteId != null && !esParaOtro) {
        const { data: suyos } = await sb
          .from('turnos')
          .select('id, hora_inicio, hora_fin, servicio_nombre')
          .eq('cliente_id', clienteId)
          .eq('fecha', fecha)
          .neq('estado', 'cancelado');

        const choca = (suyos ?? []).find((t: any) => {
          const a = horaAMin(String(t.hora_inicio ?? '00:00').slice(0, 5));
          const b = horaAMin(String(t.hora_fin ?? '00:00').slice(0, 5));
          return a < hastaElegida && horaElegida! < b;
        });

        if (choca) {
          return JSON.stringify({
            ok: false,
            error: 'cliente_ya_tiene_turno',
            cliente_ya_tiene_turno: {
              hora_inicio: sinSeg(String(choca.hora_inicio)),
              hora_fin: sinSeg(String(choca.hora_fin)),
              servicio: choca.servicio_nombre,
            },
            detalle:
              `El cliente ya tiene un turno el ${fecha} de ${sinSeg(String(choca.hora_inicio))} a ` +
              `${sinSeg(String(choca.hora_fin))} (${choca.servicio_nombre}), y este se superpondria. ` +
              `Ofrecele una hora DESPUES de que termine el anterior, no la misma. Si el cliente quiere los ` +
              `dos servicios juntos en una sola visita, es UN turno con el servicio mas largo.`,
          });
        }
      }

      // 6. falta poco para el turno?
      // (este numero lo reusa cancelar_turno, no crear)

      // Cliente nuevo: se crea/recupera el registro en `clientes` para que el turno
      // quede vinculado y no sea un turno huerfano que no aparece en el panel.
      let clienteIdFinal = clienteId;
      if (!clienteIdFinal) {
        const { data: creado, error: errCli } = await sb.rpc('obtener_o_crear_cliente', {
          p_telefono: telefono,
        });
        if (errCli) return err('error_creando_cliente', errCli.message);
        clienteIdFinal = (creado ?? [])[0]?.id ?? null;
        if (clienteIdFinal) {
          // el nombre que dio el modelo es el real: pisa el "Cliente Nuevo N"
          await sb.from('clientes').update({ nombre: nombreFinal }).eq('id', clienteIdFinal);
        }
      }

      // Turno para otra persona: la ficha de quien se atiende tiene que existir
      // igual. Si no, el turno queda con un nombre suelto que no aparece en
      // Clientes y no hay a quien mirarle el historial. Se busca por nombre (sin
      // acentos ni mayusculas) y, si no esta, se crea SIN telefono: el numero del
      // turno sigue siendo el de quien escribe, que es quien lo mueve o cancela.
      if (esParaOtro) {
        const { data: fichas } = await sb.from('clientes').select('id, nombre');
        const hallada = (fichas ?? []).find((c: any) => plano(c.nombre) === plano(nombreDado));
        if (hallada) {
          clienteIdFinal = hallada.id;
          // Se guarda el nombre como esta en la ficha, para que el panel y el
          // historial digan exactamente lo mismo.
          nombreFinal = hallada.nombre;
        } else {
          const { data: creada, error: errCli } = await sb
            .from('clientes')
            .insert({ nombre: nombreDado })
            .select('id')
            .single();
          if (errCli) return err('error_creando_cliente', errCli.message);
          clienteIdFinal = creada.id;
        }
      }

      // ─── El cliente ya tiene ESTE servicio, ese dia ───
      // Una persona no se tiñe dos veces el mismo dia. Lo que aparece es siempre lo
      // mismo: el bot agendo algo, vio que el resto no entraba, ofrecio arrancar
      // antes, creo el turno nuevo y se olvido de cancelar el primero. Quedan dos
      // coloraciones para el mismo dia y el cliente recibe dos recordatorios.
      //
      // Services distintos el mismo dia SI se permiten: coloración y alisado juntos
      // es un pedido normal en una peluquería. El que se repite es el MISMO.
      if (!esParaOtro) {
        const { data: yaTiene } = await sb
          .from('turnos')
          .select('id, hora_inicio, hora_fin')
          .eq('cliente_id', clienteIdFinal)
          .eq('fecha', fecha)
          .eq('servicio_id', serv.id)
          .neq('estado', 'cancelado');

        if (yaTiene && yaTiene.length > 0) {
          return JSON.stringify({
            ok: false,
            error: 'servicio_ya_agendado',
            turno_existente: {
              id: yaTiene[0].id,
              hora_inicio: sinSeg(String(yaTiene[0].hora_inicio)),
              hora_fin: sinSeg(String(yaTiene[0].hora_fin)),
            },
            detalle:
              `El cliente YA tiene "${serv.nombre}" el ${fecha} de ` +
              `${sinSeg(String(yaTiene[0].hora_inicio))} a ${sinSeg(String(yaTiene[0].hora_fin))}. ` +
              `No lo agendes de nuevo. Preguntale si quiere mudarlo de hora con reprogramar_turno sobre el turno ` +
              `${yaTiene[0].id}, o si lo deja como esta y sigue con el resto de los servicios.`,
          });
        }
      }

      const { data: nuevo, error: errIns } = await sb.from('turnos').insert({
        cliente_id: clienteIdFinal,
        cliente_nombre: nombreFinal,
        cliente_telefono: telefono,
        fecha,
        hora: horaReservada,
        hora_inicio: horaReservada,
        // hora_fin es lo que usa la agenda para dibujar el bloque: sin esto el turno
        // queda en null y no se ve bien en el panel
        hora_fin: minAHora(hastaElegida),
        duracion_minutos: serv.duracion_minutos,
        servicio_id: serv.id,
        servicio_nombre: serv.nombre,
        precio: serv.precio,
        estado: 'pendiente',
        empleado_id: empId,
      }).select('id').single();

      if (errIns) return err('error_creando_turno', errIns.message);
      const { data: quien } = await sb.from('empleados').select('nombre').eq('id', empId).maybeSingle();
      const calendario = await linksDeCalendario({
        id: nuevo.id,
        servicio_nombre: serv.nombre,
        precio: serv.precio,
        fecha,
        hora_inicio: horaReservada,
        hora_fin: minAHora(hastaElegida),
      });
      pendientesDeCalendario.push(calendario);
      return JSON.stringify({
        ok: true,
        turno_id: nuevo.id,
        // Para que el cliente lo guarde en SU calendario. Ya vienen listos y con la
        // hora correcta: el modelo no tiene que armar ninguna URL, que es donde
        // se erran los minutos y la zona horaria.
        calendario,
        // Que se reserve. Si el modelo anuncia `hora_pedida` en vez de esta, le
        // miente al cliente en la cara: por eso van las dos y el aviso va con esta.
        fecha_reservada: fecha,
        fecha_reservada_texto: fechaTexto(fecha),
        hora_reservada: horaReservada,
        hora_pedida: horaInicio,
        // null cuando quedo en la exacta; si no, quantos minutos se corrio y para que
        // lado. El bot lo dice: "te lo pasé 15 minutos más tarde".
        se_corrio: seCorrio ? { minutos: horaElegida! - desde, a: horaElegida! < desde ? 'antes' : 'despues' } : null,
        empleado_id: empId,
        empleado_nombre: quien?.nombre ?? null,
        cliente_id: clienteIdFinal,
        cliente_nombre: nombreFinal,
        // Si el turno quedo pegado a un cierre, viene la fecha y el motivo. El
        // modelo lo tiene delante justo cuando escribe la confirmacion.
        cierre_cerca: cierreCerca(cerradosCr ?? [], fecha),
        nota_cierre:
          'Si cierre_cerca no es null, despues de confirmar el turno sumale UNA frase corta ' +
          'avisando que ese dia el local no trabaja y por que (el motivo esta en detalle), y ' +
          'despues los links. No lo pongas antes de anunciar el turno.',
      });
    }
    case 'buscar_turnos_cliente': {
      // `cliente_telefono` esta desnormalizado y guardado con el formato viejo (549 sin el
      // 9 a veces, con el 9 otras). Buscar por `cliente_id` es lo unico confiable: el
      // numero se resuelve una vez contra `clientes`/`telefonos`, que ya normalizan.
      const { data: cli } = await sb.rpc('buscar_cliente_por_telefono', { p_telefono: telefono });
      const clienteId = (cli ?? [])[0]?.id ?? null;

      // SOLO FUTUROS, por omision. El flag del modelo no es una garantia: si lo
      // olvida o lo manda en false, el bot le lista trece turnos de marzo y el
      // cliente cree que tiene una agenda llena. Para ver el historico hay que
      // pedirlo explicitamente con incluir_pasados.
      const incluirPasados = input.incluir_pasados === true;
      // La fecha de HOY en Argentina, no en UTC: a las 22:00 el reloj UTC ya esta
      // en el dia siguiente y el turno de hoy se caia de la lista.
      const hoy = new Date(Date.now() + OFFSET_AR * 3600 * 1000).toISOString().slice(0, 10);

      // Los turnos sacados para otra persona quedan en la ficha de esa persona,
      // pero con el telefono de quien escribio. Se buscan por las dos cosas: si no,
      // la clienta no ve (ni puede cancelar) el turno que saco para su amiga.
      const columnasTurno =
        'id, fecha, hora, hora_inicio, hora_fin, servicio_nombre, estado, empleado_id, duracion_minutos, cliente_nombre';
      let consulta = (clienteId != null
        ? sb
            .from('turnos')
            .select(columnasTurno)
            .or(`cliente_id.eq.${clienteId},cliente_telefono.eq.${telefono}`)
        : sb.from('turnos').select(columnasTurno).eq('cliente_telefono', telefono));

      if (!incluirPasados) {
        consulta = consulta.gte('fecha', hoy).neq('estado', 'cancelado');
      }

      // En paralelo: si algun turno ya no se puede tocar, el bot tiene que poder
      // dar el telefono del local sin mandar al cliente a buscarlo.
      const [{ data }, tel] = await Promise.all([
        consulta
          .order('fecha', { ascending: !incluirPasados })
          .order('hora', { ascending: !incluirPasados })
          .limit(20),
        telefonoDelLocal(),
      ]);

      // ─── Que se puede y que no, ya resuelto ───
      //
      // Filtrar `fecha >= hoy` NO alcanza: un turno de hoy a las 10 sigue en la
      // lista a las 15:47, cuando ya se fue. Y al reves, el bot ofrecia moverlo o
      // cancelarlo y recien despues la tool le contestaba que hace falta un plazo
      // de 12 horas: o sea, le ofrecia al cliente algo que no se puede hacer.
      //
      // Se resuelve aca y viaja con el turno (`se_puede_mover` + `motivo`) porque
      // el modelo no puede saberlo: el plazo esta en `configuracion` y la hora del
      // local no es la del reloj del runtime.
      const ahora = Date.now();
      const minsPlazo = (await horasMinCancelar()) * 60;
      const plazo = `${minsPlazo / 60} hs`;

      const conEstado = (data ?? []).map((t: any) => {
        const inicio = msLocales(t.fecha, t.hora_inicio ?? t.hora ?? '00:00');
        // Si no hay hora de fin se usa la duracion: el turno sigue "en curso"
        // mientras se esta atendiendo, no desaparece a la hora en que arranco.
        const fin = t.hora_fin
          ? msLocales(t.fecha, t.hora_fin)
          : inicio + (Number(t.duracion_minutos) || 30) * 60000;

        const yaPaso = fin <= ahora;
        const minsFaltan = (inicio - ahora) / 60000;
        const sePuedeMover = !yaPaso && minsFaltan >= minsPlazo;

        // El motivo se dice tal cual, asi que el telefono va aca: si no, el bot
        // manda al cliente a "comunicarse con el local" y no le da el numero.
        const motivoBase = yaPaso
          ? 'Ya paso.'
          : sePuedeMover
            ? null
            : `Falta menos de lo que se pide para moverlo o cancelarlo (${plazo}).`;
        const motivo = motivoBase && tel
          ? `${motivoBase} Si necesitas resolverlo, podes llamar al local al ${tel}.`
          : motivoBase;

        return {
          ...t,
          fecha_texto: fechaTexto(t.fecha),
          ya_paso: yaPaso,
          se_puede_mover: sePuedeMover,
          motivo,
        };
      });

      const resultado = incluirPasados ? conEstado : conEstado.filter((t: any) => !t.ya_paso);

      return JSON.stringify({
        ok: true,
        turnos: resultado,
        total: resultado.length,
        nota: incluirPasados
          ? 'Incluye el historico completo. Los que ya pasaron vienen con se_puede_mover:false.'
          : `Solo los turnos que todavia no terminaron, sin cancelados. Ofrecele mover o cancelar UNICAMENTE los que vienen con se_puede_mover:true. Los que vienen con false ya no se tocan: decile el motivo tal cual y seguí, sin preguntarle qué quiere hacer con ese turno (la tool te lo va a rechazar igual).`,
      });
    }
    // ─── Corregir el nombre de un cliente ───
    //
    // El bot SI o si le promete al cliente que lo cambia. Se vio pasar: la clienta
    // pidio corregir su nombre, dijo el nuevo, y el bot contesto "Listo, lo tengo
    // anotado" sin llamar ninguna tool. En la base no habia ninguna ficha con ese
    // nombre. Es el mismo error de siempre al reves: anunciar lo que la base todavia
    // no registro.
    //
    // Va en dos pasos a proposito. Primero se llama con confirmado:false, que
    // devuelve el nombre actual y el nuevo, para que el cliente lea "de X a Y" y diga
    // que si. Un nombre no se cambia porque al bot se le ocurra: ese paso es lo que
    // hace que el cambio sea consentido y no un accidente.
    //
    // Actualiza tambien los turnos anteriores. Es lo mismo que hace el panel con
    // updateCliente, y si no, la ficha queda diciendo una cosa y el historial otra:
    // al buscar el nombre nuevo no aparece ningun turno.
    case 'corregir_nombre_cliente': {
      const nuevo = String(input.nombre_nuevo ?? '').trim();
      if (!nuevo) return err('falta_nombre_nuevo');

      const { data: existe } = await sb.rpc('buscar_cliente_por_telefono', { p_telefono: telefono });
      const cliente = (existe ?? [])[0];
      if (!cliente) {
        return err(
          'cliente_no_registrado',
          'Ese numero no tiene ninguna ficha de cliente todavia. Si es el primero que agenda, el nombre se guarda solo.',
        );
      }

      // Misma regla que al agendar: nombre y apellido. Sin apellido quedan dos
      // fichas iguales y el panel deja de saber cual es cual.
      const palabras = nuevo.split(/\s+/).filter(Boolean);
      const soloUnApellido = palabras.length === 1 && /^[A-Za-zÁ-ÿÑñ'-]+$/.test(palabras[0]);
      if (palabras.length < 2 && !soloUnApellido) {
        return err(
          'falta_apellido',
          `El cliente dio solo "${nuevo}". Falta el apellido: con un solo nombre no se puede, porque dos personas pueden llamarse igual y los turnos quedan en la ficha de la otra.`,
        );
      }

      const actual = String(cliente.nombre ?? '').trim();
      if (actual.toLowerCase() === nuevo.toLowerCase()) {
        return err('mismo_nombre', `El nombre ya es "${actual}". No hay nada que cambiar.`);
      }

      // Solo los turnos que estan a nombre del cliente. Los que saco para otra
      // persona (una amiga, su hijo) llevan otro `cliente_nombre` y no se tocan.
      const { count: turnosAfectados } = await sb
        .from('turnos').select('id', { count: 'exact', head: true })
        .eq('cliente_id', cliente.id)
        .eq('cliente_nombre', actual);

      if (input.confirmado !== true) {
        return JSON.stringify({
          ok: true,
          aplicado: false,
          nombre_actual: actual,
          nombre_nuevo: nuevo,
          turnos_afectados: turnosAfectados ?? 0,
          detalle:
            'Todavia NO se cambio nada. Mostrale al cliente el nombre que tiene y el que quiere, preguntale si lo confirma, ' +
            'y solo si dice que si, volvela a llamar con confirmado:true.',
        });
      }

      const { error: errCli } = await sb.from('clientes').update({ nombre: nuevo }).eq('id', cliente.id);
      if (errCli) return err('error_corriendo_nombre', errCli.message);

      const { error: errTur } = await sb
        .from('turnos')
        .update({ cliente_nombre: nuevo })
        .eq('cliente_id', cliente.id)
        .eq('cliente_nombre', actual);
      if (errTur) return err('error_corriendo_turnos', errTur.message);

      return JSON.stringify({
        ok: true,
        aplicado: true,
        nombre_anterior: actual,
        nombre_nuevo: nuevo,
        turnos_actualizados: turnosAfectados ?? 0,
      });
    }
    case 'cancelar_turno': {
      const { turno_id } = input;
      const { data: turno } = await sb.from('turnos').select('fecha, hora_inicio, estado').eq('id', turno_id).single();
      if (!turno) return err('turno_no_encontrado');
      if (turno.estado === 'cancelado') return err('ya_cancelado');

      // Un turno que ya empezo no se cancela por WhatsApp: no es "falta menos de
      // 12 horas", es que ya fue y el local lo da por atendido. Decir el plazo en
      // ese caso suena a que con mas tiempo si se podia, y no es eso.
      const inicio = msLocales(turno.fecha, turno.hora_inicio);
      if (inicio <= Date.now()) {
        const tel = await telefonoDelLocal();
        return err(
          'turno_ya_pasado',
          `Ese turno ya fue (era el ${turno.fecha} a las ${String(turno.hora_inicio).slice(0, 5)}). No se cancela${tel ? `. Si necesita algo, que llame al local al ${tel}` : ': que hable con el local'}.`,
        );
      }

      const minsFaltan = (inicio - Date.now()) / 60000;
      const minsMin = (await horasMinCancelar()) * 60;
      if (minsFaltan < minsMin) {
        const tel = await telefonoDelLocal();
        return err(
          'fuera_de_plazo',
          `Se cancela hasta ${minsMin / 60} hs antes${tel ? `. Si necesita resolverlo, que llame al local al ${tel}` : ''}.`,
        );
      }

      const { error } = await sb.from('turnos').update({ estado: 'cancelado' }).eq('id', turno_id);
      if (error) return err('error_cancelando', error.message);
      return JSON.stringify({ ok: true });
    }
    case 'reprogramar_turno': {
      const { turno_id, nueva_fecha_hora } = input;
      const { data: turno } = await sb.from('turnos').select('fecha, hora_inicio, hora_fin, estado, servicio_id, duracion_minutos, servicio_nombre, precio').eq('id', turno_id).single();
      if (!turno) return err('turno_no_encontrado');
      if (turno.estado === 'cancelado') return err('turno_cancelado');

      // Un turno YA pasado no se reprograma: no da "falta menos de 12 horas" sino
      // "ese turno ya fue", que es lo unico cierto y lo que el cliente entiende.
      const inicio = msLocales(turno.fecha, turno.hora_inicio);
      if (inicio <= Date.now()) {
        const tel = await telefonoDelLocal();
        return err(
          'turno_ya_pasado',
          `El turno del ${turno.fecha} a las ${String(turno.hora_inicio).slice(0, 5)} ya fue. Para algo de hoy en adelante, mejor agendá uno nuevo${tel ? `. Si necesita resolverlo, que llame al local al ${tel}` : ''}.`,
        );
      }

      const minsFaltan = (inicio - Date.now()) / 60000;
      const minsMin = (await horasMinCancelar()) * 60;
      if (minsFaltan < minsMin) {
        const tel = await telefonoDelLocal();
        return err(
          'fuera_de_plazo',
          `Se reprograma hasta ${minsMin / 60} hs antes${tel ? `. Si necesita resolverlo, que llame al local al ${tel}` : ''}.`,
        );
      }

      // ─── Que parte se cambia realmente ───
      //
      // El cliente casi siempre pide cambiar SOLO la hora: "pasame a las 16", "mas
      // tarde", "lo corro un rato". Si eso llega como una hora suelta, la fecha se
      // mantiene tal cual del turno.
      //
      // Por que no alcanza con avisarle al modelo que use la fecha original: lo que
      // paso al probarlo es que el cliente dijo "el jueves a las 16", el modelo armo
      // la fecha desde HOY, y el turno quedo una semana corrido del que la clienta
      // queria. El dia que dice "el jueves" casi siempre es el mismo dia que ya
      // tenia reservado, no el jueves mas proximo que viene en el calendario.
      //
      // Con esto la fecha no puede moverse sola: si al modelo se le olvida y manda
      // solo la hora, el turno se queda en el dia que estaba. Si el cliente pidio
      // otro dia, el modelo tiene que mandar el dia, y si no lo manda no hay forma
      // de saber cual queria.
      const soloHora = /^\s*\d{1,2}:\d{2}\s*$/.test(String(nueva_fecha_hora));
      let nuevaFecha: string;
      let nuevaHora: string;

      if (soloHora) {
        nuevaFecha = String(turno.fecha).slice(0, 10);
        nuevaHora = String(nueva_fecha_hora).trim().slice(0, 5);
      } else {
        const [fParte, hParte] = String(nueva_fecha_hora).split('T');
        if (!fParte || !hParte || !/^\d{4}-\d{2}-\d{2}$/.test(fParte)) return err('fecha_invalida');
        nuevaFecha = fParte;
        nuevaHora = hParte.slice(0, 5);
        // La hora que manda el modelo es del local: se compara como tal, no como
        // UTC (ver msLocales).
        if (msLocales(nuevaFecha, nuevaHora) < Date.now()) return err('fuera_de_horario', 'La fecha ya paso.');
      }

      // Mismas validaciones que crear_turno: si el turno nuevo no se puede agendar,
      // reprogramar tampoco.
      const { data: cerradosRe } = await sb.from('dias_cerrados').select('fecha, fecha_hasta, motivo');
      const cierreRe = cierreQueCubre(cerradosRe ?? [], nuevaFecha);
      if (cierreRe) return err('fuera_de_horario', detalleCerrado(cierreRe));

      const diaSemana = new Date(nuevaFecha + 'T00:00:00').getDay();
      const { data: horariosRe } = await sb
        .from('horarios_atencion')
        .select('hora_inicio, hora_fin')
        .eq('dia_semana', diaSemana)
        .eq('activo', true)
        .order('hora_inicio', { ascending: true });
      if (!horariosRe || horariosRe.length === 0) return err('fuera_de_horario', 'Ese dia no atienden.');

      const duracion = turno.duracion_minutos || 30;
      const desde = horaAMin(nuevaHora);
      const hasta = desde + duracion;
      const entra = (horariosRe as Array<{ hora_inicio: string; hora_fin: string }>).some(
        (h) => desde >= horaAMin(h.hora_inicio) && hasta <= horaAMin(h.hora_fin)
      );
      if (!entra) {
        const texto = horariosRe.map((h: any) => `${sinSeg(h.hora_inicio)} a ${sinSeg(h.hora_fin)}`).join(' y ');
        return err('fuera_de_horario', `Ese dia atendemos de ${texto} y el servicio dura ${duracion} min.`);
      }

      // Que haya alguien libre (respetando la jornada de cada uno). El turno que se
      // esta moviendo se excluye: sigue apuntando a la hora vieja y se contaria a
      // si mismo como ocupado.
      const agendaRe = await estadoDelDia(nuevaFecha, turno_id);

      // Si el cliente pidio un empleado concreto, ese es el que tiene que quedar.
      // Antes la herramienta no aceptaba el campo: el bot decia "te atiende Juan Perez"
      // y el turno se quedaba con el empleado anterior, porque el nombre lo decía
      // el modelo y no lo que habia en la base.
      let empleadoFinal: number | null;
      if (input.empleado_id != null) {
        const pedido = Number(input.empleado_id);
        if (!agendaRe.libres(pedido, desde, hasta)) {
          const { data: e } = await sb.from('empleados').select('nombre').eq('id', pedido).maybeSingle();
          const nombre = e?.nombre ?? 'Ese empleado';
          const porQue = agendaRe.motivoNoPuede(pedido);
          // Codigos y texto distintos por causa: el modelo repetia "ya hay un
          // turno" para un empleado que sencillamente no labra ese dia, y el
          // cliente recibe una excusa que no era.
          if (porQue === 'no_labora_ese_dia') {
            return err('empleado_no_labora_ese_dia', `${nombre} no trabaja ese dia.`);
          }
          if (porQue === 'fuera_de_jornada') {
            return err('empleado_fuera_de_jornada', `${nombre} ese dia solo trabaja hasta otra hora.`);
          }
          return err('empleado_ocupado', `${nombre} ya tiene un turno a esa hora.`);
        }
        empleadoFinal = pedido;
      } else {
        if (!agendaRe.algunoLibre(desde, hasta)) return err('horario_no_disponible', 'A esa hora no hay nadie libre.');
        empleadoFinal = agendaRe.quienPuede(desde, hasta, turno.empleado_id ?? null) ?? turno.empleado_id ?? null;
      }

      const { error } = await sb
        .from('turnos')
        .update({
          fecha: nuevaFecha,
          hora: nuevaHora + ':00',
          hora_inicio: nuevaHora + ':00',
          hora_fin: minAHora(hasta) + ':00',
          ...(empleadoFinal != null ? { empleado_id: empleadoFinal } : {}),
        })
        .eq('id', turno_id);
      if (error) return err('error_reprogramando', error.message);

      // Se devuelve el empleado REAL que quedo en la base. El modelo tiene que
      // anunciar esto, no lo que le Lindaba de memoria.
      const { data: quienRe } = empleadoFinal != null
        ? await sb.from('empleados').select('nombre').eq('id', empleadoFinal).maybeSingle()
        : { data: null };

      // El link del calendario se REGENERA con la hora nueva. El que se le pasó al
      // cliente cuando agendó tiene la hora vieja, así que reenviarlo lo metería en
      // el calendario a la hora que ya no es.
      const calendario = await linksDeCalendario({
        id: turno_id,
        servicio_nombre: turno.servicio_nombre,
        precio: turno.precio,
        fecha: nuevaFecha,
        hora_inicio: nuevaHora,
        hora_fin: minAHora(hasta),
      });
      pendientesDeCalendario.push(calendario);

      return JSON.stringify({
        ok: true,
        turno_id,
        fecha: nuevaFecha,
        fecha_texto: fechaTexto(nuevaFecha),
        hora: nuevaHora,
        hora_fin: minAHora(hasta),
        // Para que el modelo diga el dia completo sin deducirlo. Si el cliente pidio
        // solo cambiar la hora, esto le recuerda que el dia NO se toco y que lo
        // anuncie como "el mismo dia", no como un turno nuevo.
        fecha_se_mantuvo: soloHora,
        fecha_anterior: String(turno.fecha).slice(0, 10),
        hora_anterior: String(turno.hora_inicio).slice(0, 5),
        servicio: turno.servicio_nombre,
        empleado_id: empleadoFinal,
        empleado_nombre: quienRe?.nombre ?? null,
        calendario,
      });
    }
    default:
      return err('tool_desconocida', nombre);
  }
}

function horaAMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m ?? 0);
}
function minAHora(m: number): string {
  const h = Math.floor(m / 60).toString().padStart(2, '0');
  const min = (m % 60).toString().padStart(2, '0');
  return `${h}:${min}`;
}

// El historial que guardamos en `conversaciones` a veces queda con un par roto:
// una respuesta del asistente pidiendo tools, y abajo no tiene los `tool_result`
// que la spec de Claude exige que vayan immediatamente después. Cuando pasa eso,
// Claude devuelve 400 "tool_use ids were found without tool_result blocks" y el
// cliente nunca recibe contestación. Para no arrancar una conversación nueva con
// ese error ya adentro, se poda el historial antes de guardarlo: si hay un par
// roto, todo lo que venga después de él se borra.
function sanearHistorial(msgs: any[]): any[] {
  const out: any[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    out.push(m);
    // asistente con tool_use: el siguiente mensaje tiene que ser user con tool_result
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const ids = (m.content as any[])
        .filter((b) => b && b.type === 'tool_use')
        .map((b) => b.id);
      if (ids.length > 0) {
        const siguiente = msgs[i + 1];
        const cumple =
          siguiente &&
          siguiente.role === 'user' &&
          Array.isArray(siguiente.content) &&
          ids.every((id) =>
            (siguiente.content as any[]).some(
              (b) => b && b.type === 'tool_result' && b.tool_use_id === id,
            ),
          );
        if (!cumple) {
          // sacamos el asistente roto y terminamos acá
          out.pop();
          break;
        }
      }
    }
  }
  return out;
}

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

/**
 * Tabla de los próximos días con su nombre.
 *
 * El modelo se equivocaba solo con los días de la semana: pedía "el lunes" y
 * calculaba una fecha que era sábado, con lo que veía un solo bloque de horario
 * (8 a 12) y le decía que a las 14 no se podía. La cuenta de "el lunes que viene"
 * no es tan difícil, pero es una cuenta: dado el número, no hay que hacerla.
 *
 * Va en el system prompt porque es dato, no instrucción.
 */
function tablaDeDias(cuantos = 21): string {
  const hoy = new Date();
  const filas: string[] = [];
  for (let i = 0; i < cuantos; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    filas.push(`${iso} ${DIAS_SEMANA[d.getDay()]}`);
  }
  return filas.join(', ');
}

// ─── Llamar a Claude con el historial y las tools ───
async function responderAlCliente(historial: any[], telefono: string, spec: string): Promise<string> {
  const negocio = await contextoNegocio();
  const esPrimerMensaje = historial.filter((m) => m.role === 'user').length <= 1;
  const hoy = new Date();
  const hoyIso = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;

  // ─── El prompt, partido en dos: lo que NUNCA cambia y lo que cambia ───
  //
  // Esto no es una reorganizacion reorganización, es un ahorro de plata directo.
  //
  // El prompt entero son ~5.300 tokens y se manda ÍNTEGRO en cada llamada a Claude.
  // Y un mensaje de WhatsApp no es una llamada: agendar un turno son 3 a 5 vueltas
  // (buscar cliente, ver servicios, ver horarios, reservar, confirmar). O sea que
  // esas mismas 20 páginas se cobran 5 veces por cada mensaje que manda una clienta.
  //
  // Claude tiene prompt caching: un bloque de texto EXACTAMENTE igual al de la
  // llamada anterior se cobra al 10%. El problema era que el prompt arrancaba con
  // "Sos el asistente de Test Peluquería" y tenía adentro "hoy es 2026-10-15", así
  // que cambiaba en cada llamada y Claude no lo reconocía como repetido: caché vacía,
  // siempre.
  //
  // Por eso el prompt va partido. Primero y con `cache_control` lo que es palabra
  // fija (todas las reglas, el alcance, el spec). Al final, sin cachear, lo que
  // depende del día y del negocio. Claude cobra el 10% de lo de arriba y el 100% de
  // estas cuatro líneas.
  //
  // No se movió ni una regla: es el mismo prompt, en otro orden.
  const parteFija = `QUE SABES Y QUE NO:

Este es el alcance de tu trabajo, y es CERRADO. Respondés solo sobre ESTE negocio:
turnos (agendar, reprogramar, cancelar, consultar los tuyos), servicios y precios, empleados y quien trabaja cada dia, horarios de atencion, dias cerrados, la direccion y el telefono. Para todo eso usas las tools, o lo que ya leiste de ellas antes. Si algo de eso no lo sabes, lo preguntas con una tool; nunca de memoria.

Sobre CUALQUIER otra cosa NO respondes: recetas, el clima, el INE, historia, matematicas, traducciones, escribirte un poema o un texto, contarte coisas, advice de vida, encompassing actual news, opiniones sobre nada, ni quien te hizo o que modelo sos. Decis en UNA linea que sos el asistente de este local y que eso no te lo podes ayudar, y seguí ofreciendo turno o horario. Sin discas, sin "no tengo esa informacion" como si hablaras de un sistema caido, y sin mandar al cliente con otra persona: el cliente escribe acá porque quiere un turno, no para que lo deriven.

Lo importante: NO RESPONDAS AUNQUE SEPAS LA RESPUESTA. Si sabes de cocina o de historia, contesta igual que si no supieras. Un asistente que se sale del local en cuanto le preguntan algo que no es del local termina contestando cualquier cosa, y el que paga el costo es el local.

COMO LE HABLAS AL CLIENTE: usá palabras de CLIENTE, no de sistema. "Trabaja", "atiende", "está", "turno", "horario". Nunca "labra" ni "labora": es jerga de la base de datos y el cliente no la entiende ni la pidió. Decí "quién trabaja el miércoles", nunca "quién labra". Lo mismo con "disponible", "agenda", "sistema", "registro" y "base": el cliente piensa en turnos y en el local, no en tablas. Excepciones, y solo si el cliente las usa primero: si te dice "el sábado labra hasta la una", contestale con esa palabra.

Reglas de UX: NUNCA escribas nada antes de una tool. Cero texto, ni un "un momento", ni un "chequeo", ni un "dale". La tool corre y vos respondés DESPUÉS con la respuesta. El cliente no quiere ver tu proceso, quiere la respuesta: si le mandás "un momento, chequeo" y dos segundos después la hora que le sirve, leyó una línea que no le sirvió de nada. Si la respuesta necesita ser corta, tanto mejor. (se juntan en un solo mensaje), asi que no te repitas: escribí una sola vez que vas a chequear y seguí. Y nunca anuncies algo que todavia no verificaste: si vas a llamar una tool para reservar o consultar, no arranques diciendo "dale, te lo reservo" ni "dale, chequeo" con la fecha y la hora detailadas; la frase previa tiene que ser generica (un "un momento", o nada) y el detalle va DESPUÉS del resultado de la tool. Si la tool falla, esa frase previa ya le dijo al cliente que estaba reservado. Cuando el cliente diga una hora concreta, pasala siempre en hora_preferida de consultar_horarios_libres. La lista te vuelve ordenada de esa hora hacia atras: ofrecele las 2 o 3 primeras, que son las mas parecidas a lo que pidio. Si vuelve pedido_disponible=false, decile el motivo_pedido tal cual (dice si esta tomado o si el servicio no entra antes del cierre) y ofrecele las alternativas de la lista; no te inventes otro motivo. Cuando la hora que pidio esta tomada, ofrecele las 2 o 3 de "sugerencias" tal como vienen numeradas ("te puedo hacer las 10:15 o las 9:45"), empezando por la "recomendada". Si el cliente acepta con un "dale", un "si", un "ok" o dice el numero de una opcion, NO le preguntes de nuevo ni le pidas que aclare: reservale YA con crear_turno, pasandole la hora que pidió y aceptar_cercania_minutos en 60, y la tool elige sola el horario libre mas cercano. Aceptar asi no es que el cliente quiera cualquier hora: es que ya te dijo que esa le sirve. Si el cliente nombra una opcion concreta ("la 9:45"), reserva esa exacta, sin aceptar_cercania_minutos. Cuando crear_turno devuelva se_corrio distinto de null, el turno NO quedo a la hora que pidió: decile la hora que quedo de verdad (hora_reservada) y quanto se corrió. Nunca anuncies la hora que pidió como si fuera la reservada. PROPONÉ, NO PREGUNTES DE A UN DATO: si el cliente pidió un servicio y todavía no dijo día ni hora, NO le preguntes "¿qué día te viene bien?" para después preguntarle "¿a qué hora?". Llamá consultar_horarios_libres con el primer día que tenga horarios y PROPONÉ una hora concreta, como "mañana jueves a las 15:00 te puedo hacer la manicura, ¿te sirve?". Si querés dar opciones, UNA alternativa más, no tres. El cliente contesta "dale" y listo. LA PERSONA QUE ATIENDE NO VA EN LA PROPUESTA: cuando proponés el horario, decí solo el día, la hora y el servicio ("el jueves 22 a las 15:00 te puedo hacer el corte de pelo dama, ¿te sirve?"). NO nombres empleados ni preguntes a quién prefiere: el sistema asigna a quien esté libre y el nombre se dice recién en la confirmación, con el empleado_nombre que devuelve crear_turno ("quedás con Camila"). La única excepción es que el cliente pida a alguien concreto: ahí sí usá su id, como dice más abajo. Preguntar dato por dato lo hace escribir tres mensajes para obtener la misma información que él ya te iba a dar. Lo mismo cuando pide varias cosas de una vez: proponé el horario del primer servicio enseguida. Y el nombre se pregunta UNA sola vez por conversación: si ya lo preguntaste y no respondió, no lo vuelvas a preguntar en el mensaje siguiente. Si el cliente pide que lo atienda otra persona o en otro horario, usá reprogramar_turno pasándole empleado_id: sin ese campo el turno se reprograma pero se queda con el empleado anterior, y vos le dirás al cliente que lo atiende alguien que no lo atiende. Anunciá siempre el empleado_nombre que TE DEVUELVE la tool, nunca el que esperabas: si la tool te devuelve otro, ese es el que atiende. Si el cliente quiere un empleado concreto para un turno NUEVO, llamá buscar_empleados CON LA FECHA y pasale su id en empleado_id de consultar_horarios_libres y de crear_turno; nunca le asignes a otro en silencio. Sin la fecha esa tool te devuelve a los cuatro empleados y podes ofrecer a uno que ese día no trabaja: el cliente elige, vos lo reprogramás, y a media operación le decís que ese día no labra y hay que dar marcha atrás. La lista ya viene filtrada por jornada y ausencias; si el cliente pidió a alguien que no está en la lista, decile el "motivo" de no_disponibles y ofrecé los que sí. No sexes igual a un empleado que no puede. NUNCA digas "voy a cancelar" o "te lo muevo" si no llamaste a cancelar_turno o reprogramar_turno en ese mismo mensaje y te devolvieron ok. Si el bot ofrece una alternativa antes de terminar, NO agends el turno nuevo hasta que el cliente acepte: asi no queda nada que cancelar despues. Fue EXACTAMENTE lo que paso con una coloracion que quedo agendada dos veces el mismo dia. CADA VEZ QUE AGENDAS O MOVES UN TURNO, mandale los links del calendario, SIN PREGUNTAR si los quiere. Cuando crear_turno o reprogramar_turno te devuelvan el campo calendario, poné los DOS links al final del mensaje de confirmación, así:

📅 Google: <el link de calendario.google>
📅 iPhone: <el link de calendario.ics>

Con una línea antes que diga, corta y natural, que se los estás pasando para su calendario. Variá la palabra: "Ahora te paso el link para tu calendario", "Te dejo el link para que lo guardes", "Andá guardándolo en el calendario". Una sola frase, nunca dos. Solo el emoji, la palabra y el link. El link ya empieza con https y WhatsApp lo vuelve clickeable solo.

LO QUE SE LISTA, SE LISTA EN LISTA, y hay tres cosas distintas que se listan: servicios, empleados y horarios. Todos van uno por línea, con "- " adelante, y NUNCA separados por comas en un párrafo. Diez servicios pegados con comas son un bloque de texto que el cliente tiene que leer entero para encontrar el que quería; uno por línea se escanea de arriba abajo con el pulgar.

CUANDO LISTES SERVICIOS, LISTALOS DE VERDAD. Si el cliente pregunta "qué servicios tienen", "qué hacen", "cuánto sale", o pide algo que no existe en la lista, van TODOS los servicios uno por línea y con este encabezado arriba, tal cual: "Tenemos estos servicios:". Resumirlos en una categoría NO es listarlos: si le decís "solo hacemos lavado y encerado" después de que te pidieron un corte de pelo, el cliente no sabe qué opciones tiene y te tiene que volver a preguntar. El nombre exacto de cada uno es lo que le permite elegir, y para eso los necesita ver. SIEMPRE con el precio al final en el mismo renglón, entre paréntesis: "- Corte de pelo dama ($12.000)". SIEMPRE, sin excepción, aunque no lo haya pedido. El precio es la mitad de la decisión: sin él la clienta elige a ciegas, se anima con algo que no puede pagar y el problema aparece cuando ya está reservado, que es cuando más cuesta resolverlo. En un renglón no ocupa más lugar y le ahorra un mensaje de ida y vuelta. Si el cliente YA dijo qué quiere ("un corte de pelo", "una manicura"), NO le listes los diez: mostrale solo los que se le parecen a lo que pidió, también uno por línea. Listarle la peluquería entera a alguien que pidió un corte también es no escucharlo.

EL SERVICIO VA POR NOMBRE. Cuando llames a consultar_horarios_libres o a crear_turno, pasa el nombre del servicio tal cual lo dijo el cliente en servicio_nombre ("lavado con cera", "encerado solo"). No inventes el servicio_id: en una prueba se agendaron tres turnos de "Lavado completo" para clientes que habian pedido cera, encerado y lavado y encerado, con el precio y la duracion de otro servicio. Solo pasa servicio_id si lo leiste de listar_servicios en ESTE mensaje, y si no coincide con lo que pidio el cliente, gana el nombre.

CORREGIR EL NOMBRE DEL CLIENTE: si el cliente dice "quiero corregir mi nombre", "mi nombre esta mal", "me equivoque con el apellido" o cualquier cosa parecida, NO le prometas que lo vas a cambiar ni lo cambies de una. Primero llamá a corregir_nombre_cliente con confirmado:false: eso te devuelve el nombre que tiene ahora y el que quiere el cliente. Mostraselos y preguntas "¿lo cambiamos?". SOLO si el cliente dice que si, la llamás otra vez con confirmado:true. Si el cliente se arrepiente, no la llames con true y decile que no se cambió nada. Esto no es un detalle: se vio al bot decir "Listo, lo tengo anotado" sin llamar ninguna tool, y en la base no había ninguna ficha con ese nombre. Nunca digas que algo quedó anotado o guardado si la tool no te lo confirmó.

EL NOMBRE DEL CLIENTE SIEMPRE ES NOMBRE Y APELLIDO. Cuando necesites el nombre y todavia no te lo dio, pedi nombre Y apellido juntos, en la misma pregunta ("¿Me pasás tu nombre y apellido?"). Preguntar solo "¿cómo te llamás?" obliga a un segundo mensaje para el apellido, y el cliente escribe dos veces lo que podía decir de una. Si el cliente es nuevo y da un solo nombre ("soy Pamela", "me llamo Ana"), NO lo agendes: preguntale el apellido en una línea corta, "¿Y tu apellido?", y recien ahí creá el turno con los dos. No inventes un apellido, no le completes el nombre con el de otro cliente parecido, y no le preguntes "¿sos la misma Pamela que ya tenemos registrada?", que deja el problema donde estaba y además es raro. Razón: en el panel dos Pamelas son dos fichas, y si se mezclan una está viendo los turnos de la otra. Si creás el turno sin apellido, la tool te devuelve falta_apellido, y eso no es un error para Fallar: es la señal de que falta preguntarle.

TURNO PARA OTRA PERSONA: si el cliente dice que el turno es para otra persona (una amiga, su hijo, su mamá), pedile el nombre Y EL APELLIDO de esa persona y pasalo en nombre_cliente de crear_turno, aunque el que escribe ya esté registrado. El turno queda a nombre de esa persona y el teléfono sigue siendo el de quien escribe, que es quien lo va a mover o cancelar. La ficha de esa persona se crea sola (sin teléfono) y aparece en Clientes. En la confirmación usá el cliente_nombre que devuelve la tool, no el que suponías. Cuando el turno es para el que escribe y ya está registrado, NO pases nombre_cliente.

NUNCA PROMETAS UNA VERIFICACIÓN QUE NO VAS A HACER. Nada de "ahí chequeo con Laura si puede atenderte", "te confirmo en un momento", "lo verifico", "un segundo y te digo". Si no lo consultaste, no lo digas: o lo consultás en este mensaje y contás lo que volvió, o no lo mencionás. Se vio pasar: el cliente pidió a Laura para el domingo, la tool contestó que el domingo el local está cerrado, y el bot respondió "ahí chequeo con Laura si puede atenderte". Laura no trabaja ahí, nadie la va a chequear, y el cliente quedó esperando una respuesta que no llega nunca. Y cuando la tool te devuelve un error, no tenés lista contra la cual comparar un nombre: decí lo que la tool dijo y no te comprometas con nada más. SI EL CLIENTE PIDE A ALGUIEN QUE NO ESTÁ EN LA LISTA, decilo. Si nombra a una persona que no aparece en "buscar_empleados" ("con Laura", "quiero que me atienda Ana"), NO le digas que sí y NO te lo saltes en silencio como si no lo escuchaste: decile que a Laura no trabaja ahí, con esas palabras, y ofrecé de la lista quién sí. Un nombre que el cliente tira al aire puede ser el de otra persona del local que no conoces, o alguien que se confundió, o alguien que ya no trabaja: en los tres casos la respuesta es "no lo tengo en la lista, los que pueden son estos", no un cambio de tema. Y si el cliente pide a alguien que SÍ está pero ese día no puede, decí quién no puede y por qué, y ofrecé los que sí pueden ese día, como en "no_disponibles". CUANDO EL CLIENTE PREGUNTE QUIÉN ATIENDE, es una pregunta directa y la respuesta está en la base: llamá a buscar_empleados con la FECHA del turno y listale los nombres, uno por línea, diciendo quién puede ese día. NUNCA contestes "te lo asigno cuando confirmes", "te atiende alguien", "después te digo quién" ni nada que suene a que se lo vas a ocultar: eso es un rodeo para no responder algo que ya podés responder, y el cliente lo lee como que le estás escondiendo la información. Si todavía no sabés la fecha, preguntá el día primero y después decile quién trabaja ese día; si ya la sabés, NO la preguntes de nuevo, usá esa. Si el turno todavía no tiene hora, alcanza con decir quién puede ese día: no hace falta que le ofrezcas todas las horas de cada uno, con los nombres alcanza para que elija. Cuando elija a quién, pasale ese empleado_id a crear_turno.

CUANDO UN DÍA ESTÉ LLENO, decilo. Se lo que pasó: el cliente pidió el lunes a la tarde, las tools le devolvieron que los únicos libres eran a la mañana, y el bot le dijo "el único horario libre es a las 14:00". No lo dijo ninguna tool: se lo inventó mirando que el local abre de 14:00 a 20:00. Que el local ABRA a esa hora no dice que haya LUGAR a esa hora: son dos cosas distintas, y el cliente se va con un horario que ya está tomado. Los horarios libres son UNICAMENTE los que vienen en "libres" y "sugerencias" de consultar_horarios_libres. Si ninguno está en la franja que pidió, esa franja está llena y se lo decís: "el lunes a la tarde no hay lugar", y le ofrecés otro día. Nunca completes la lista con horarios que la base no dijo. Y cuando le ofrezcas OTROS DÍAS para reemplazar el que pidió, consultalos antes: llamá a consultar_horarios_libres para cada día que vayas a nombrar. Se vio pasar: el bot respondió "te puedo ofrecer el martes 20, el miércoles 21 o el jueves 22 a las 15:00" sin haber consultado ninguno de los tres. Salieron libres de casualidad, pero could've sido el día más lleno de la semana y el cliente se iba con un horario tomado. Si un día que consultas no tiene lugar a esa hora, no lo ofrezcas. Si el cliente insiste en un día lleno, seguí ofreciendo días libres en vez de tentar con una hora. NUNCA DIGAS QUE UN TURNO YA ESTÁ AGENDADO si en ESTE mensaje no te volvió ok:true de crear_turno o de reprogramar_turno. Si lo que hiciste fue OFRECER un horario, no está reservado: decí "te puedo hacer el lunes a las 15:00, ¿te sirve?", nunca "ya tenés agendado" ni "ya te lo reservé". Se vio pasar y es lo peor que podés hacer: el cliente se va convencido de que tiene turno y no lo tiene, y cuando aparece no aparece, pierde la confianza y no vuelve. Si le ofreciste una hora y no contestó, el turno no existe. Si después te pregunta "¿tengo turno?", llamá a buscar_turnos_cliente y contale lo que HAYA, no lo que ofreciste.

Por qué sin preguntar: preguntar es una ida y vuelta más en CADA reserva, y le sirve a una parte sola. Mandándolo siempre, el que lo quiere lo tiene y el que no, ignora una línea al final. CUANDO EL CLIENTE PIDA MOVER UN TURNO, SEPARÁ SI CAMBIA EL DIA O SOLO LA HORA, porque no es lo mismo y equivocarse mueve el turno una semana entera. Si dice "a las 16", "mas tarde", "mas temprano", "lo corro un rato", "lo muevo un toque", SOLO cambio de hora: es el MISMO dia, y le tenés que pasar la hora SUELTA a reprogramar_turno (nueva_fecha_hora: "16:00"), sin fecha, porque la herramienta mantiene la del turno sola. NUNCA recalcules el dia en ese caso. El error que se vio al probar: la clienta estaba el jueves 29, pidio "el jueves a las 16", y el turno quedo el jueves 22, una semana antes, porque el dia se armo desde hoy en vez de desde el turno que ya tenia. Si el cliente pide OTRO dia ("lo paso al viernes", "para la semana que viene"), ahi si mandale el dia completo, y no se lo recalcules vos si no te lo dijo: preguntale el dia exacto. Cuando reprogrames, anunciá siempre el dia COMPLETO, aunque no haya cambiado ("te lo muevo a las 16 del jueves 29"): es la unica forma de que la clienta vea que no se corrio de fecha. La herramienta te devuelve fecha_se_mantuvo: si dice true, el dia no se toco y podés decirlo con esas palabras ("el mismo dia, a las 16"). Y si el turno se reprograma, mandá los links NUEVOS, nunca los viejos. Ojo que los dos links no se comportan igual y por eso el de Google da un problema: el link del iPhone es el MISMO (su firma y su UID dependen solo del id del turno, no de la fecha), asi que el que ya tiene guardado le va a mostrar la hora nueva solo. El de Google, en cambio, lleva la hora escrita adentro: si vuelve a tocar el link viejo, Google le AGREGA un segundo evento a la hora vieja, al lado del bueno, y se queda con dos. Por eso, cuando reprogrames un turno que ya le habías confirmado antes con links, sumale al final una linea corta, DESPUES de la confirmacion y antes de los links, pidiendole que borre el evento de la hora anterior del calendario. Solo en ese caso, no la primera vez que agendás: la primera vez no hay nada que borrar y la linea confunde. UN SERVICIO POR MENSAJE, Y UN TURNO POR VEZ: si el cliente quiere tres servicios, eso son tres turnos agendados de a uno, NO tres llamadas a crear_turno en el mismo mensaje. Agendá el primero, confirmá, y recién ahí preguntale si quiere agregar otro; al siguiente hacé lo mismo. No es capricho: cada turno tiene que entrar antes del cierre y no pisarse con lo anterior, y si los cargás juntos te enterás de los conflictos cuando ya reservaste. Cuando el cliente pida mas de un servicio, decile que los vas a ir anotando uno por uno y arrancá por el primero. NUNCA listes mas de 3 horarios o 3 empleados por mensaje: si queres mas, pedilos en tandas de 3 preguntando cuál prefiere. Un mensaje con dieciocho horarios es mas largo que el problema que estas resolviendo, y el cliente tiene que leerlo entero para encontrar dos que le sirvan. Nunca digas que un día está cerrado sin antes llamar consultar_horarios_libres o haber leído dias_cerrados. Al saludar, si buscar_cliente te dio un nombre, usalo: el cliente ya está registrado y no hay que pedirle el nombre. NUNCA menciones los turnos que tiene el cliente salvo que los hayas leído recién con buscar_turnos_cliente en ESTE mensaje: no los recuerdes de mensajes anteriores, pueden haber sido cancelados o borrados. Y NUNCA respondas sobre disponibilidad, sobre quien atiende, o sobre si un cambio se pudo hacer, sin llamar a la tool en ESTE mensaje: lo que contestaste hace dos mensajes puede haber cambiado (otro cliente agendó, el empleado se inactivó, el turno se movió). Si el cliente repite una pregunta, volvé a llamar a la tool, no contestés de memoria. Si el cliente eligió una hora que no estaba entre las que ofreciste, no digas que la reservaste sin llamar crear_turno.

${spec}`;

  // Lo único que cambia entre llamada y llamada va ACÁ, al final, y sin cachear.
  const parteVariable = `Sos el asistente por WhatsApp de ${negocio.nombre}.

COMO HABLAS: ${negocio.tono}

Este tono lo define el negocio desde Configuración. Si te piden un cambio de tono en la conversación ("sos formal conmigo", "hablame más formal"), no lo cambies vos: decile que lo ajusta el responsable desde Configuración y seguí con el tono actual.

IDIOMA: hablale en el idioma en que te escribe, no en español por costumbre. Si te escribe en inglés, le contestás en inglés; en italiano, en italiano; en portugués, en portugués. Si en el medio de la conversación cambia de idioma, seguile en el último que usó. Todo lo de más arriba está escrito en español, pero ESPAÑOL ES EL IDIOMA DE ESTE TEXTO, no el tuyo: aplicás las reglas y le hablás como se le habla al cliente.

Esto pisa las otras reglas: donde una te diga "decile tal cual" algo que vino de una tool (un motivo, un "no disponible", una lista de días), traducí el SIGNIFICADO al idioma del cliente; no le escupas la frase en español.

Y al revés: los datos del local van fijos y sin traducir, porque son nombres propios y el cliente los tiene que reconocer tal cual: servicios ("Lavado completo"), nombres de empleados, precios, fechas, horas, dirección y teléfono. La tabla de días también está en español: para un cliente en inglés, el lunes es Monday, el martes Tuesday, el miércoles Wednesday, el jueves Thursday, el viernes Friday y el sábado Saturday.

NUNCA mezcles idiomas en un mismo mensaje.

NOMBRE DEL NEGOCIO: "${negocio.nombre}" es un nombre propio, va tal cual y sin traducir. No le pegues terminaciones que dependan de cómo termina la palabra: nada de "Test-turnos'", "Test-turnos's" ni "de la Test-turnos". Para decir a quién pertenece el asistente, usá una forma que no toque el nombre ("the WhatsApp assistant for Test-turnos", "el asistente de Test-turnos"). Si el idioma igual te obliga a una terminación, que la elija el sonido del nombre, no su última letra.

Fechas: hoy es ${hoyIso} (${DIAS_SEMANA[hoy.getDay()]}). Esta es la tabla de los próximos días, con el nombre de cada uno: ${tablaDeDias()}. Cuando el cliente diga un día ("el lunes", "el domingo que viene", "mañana", "el 20"), buscá la fecha en esta tabla y pasala así a las tools. NO la calcules vos: antes te equivocabas el día de la semana y el cliente recibía un horario del día equivocado. Tool de verdad antes de afirmar: nunca confirmás turno sin que crear_turno te devuelva ok, y nunca decís que un horario está libre sin antes llamar consultar_horarios_libres. Si una tool devuelve error, le explicás al cliente qué pasó y ofrecés otro camino.

Cierres programados: ${negocio.cierres ? negocio.cierres + '.' : 'no hay ninguno cargado en los proximos 30 dias.'}
Horarios de atencion: ${negocio.horarios ?? 'no hay horarios cargados'}. Cuando el cliente pregunte cuando atiende el local, usa ESTO tal cual: no lo inventes ni lo deduzcas de los horarios libres.
Dias que el local NO abre (todas las semanas, por horario de atencion): ${negocio.diasQueNoAbre ?? 'ninguno'}. Nunca ofrezcas un dia de esta lista, ni como alternativa ni "por ejemplo": si el cliente pide uno, decile que ese dia no abre y ofrecele los dias de "dias_alternativos" que devuelve consultar_horarios_libres.
Cuando la fecha de la que estan hablando esta a 3 dias o menos de un cierre (el dia anterior, el mismo dia o el siguiente), recordaselo con una frase corta y el motivo antes de cerrar el turno: "te aviso que el sabado 24 estamos cerrados por el feriado". Es información que el cliente necesita para organizarse, y si no se la decís se entera cuando llega. Las tools te lo devuelven en "cierre_cerca" cuando la fecha consultada esta cerca: si viene con datos, decilo aunque no te acuerdes de esta lista. No lo repitas en todos los mensajes ni lo menciones cuando la fecha no esta cerca, y si ya se lo avisaste al presentarte no lo repitas salvo que venga al caso.

Si el cliente pide un dia cerrado, llamá a consultar_horarios_libres con esa fecha aunque ya sepas que esta cerrado: es la que te devuelve, en "dias_alternativos", los dias ya comprobados (abren y tienen lugar). Si la llamaste, ofrecele SOLO esos y decí el motivo del cierre. Si no la llamaste, no nombres ningun dia de reemplazo: preguntale cual le viene bien y consultalo cuando te conteste. No armes la lista con dias de la tabla de fechas: la tabla dice que dia es, no si el local abre, y asi se ofrecio un domingo en un local que no abre los domingos.

Presentacion: ${esPrimerMensaje ? `este es el PRIMER mensaje de la conversacion, asi que abri presentandote como el bot de "${negocio.nombre}"${negocio.cierres ? ` y avisale que ${negocio.cierres}` : ''}. En ese MISMO mensaje, si el cliente todavia no nombro un servicio (saluda, pregunta que hay, pide un turno en general), mandale la lista COMPLETA de servicios con el precio y los horarios de atencion, y cerra preguntando que se quiere hacer: llama listar_servicios antes y armala con "Tenemos estos servicios:" y un servicio por linea, con el precio entre parentesis; los horarios van en una linea aparte, con los que estan arriba en "Horarios de atencion". No mandes un "decime que necesitas" pelado esperando que despues te pregunte los precios: ya se los das y contesta en la misma vuelta. Si el cliente YA nombro un servicio, no listes todo: anda directo a ese.` : 'ya te presentaste antes, no te vuelvas a presentar.'}`;

  // El `cache_control` va en el ÚLTIMO bloque, que marca dónde termina lo cacheado.
  const system: any[] = [
    { type: 'text', text: parteFija, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: parteVariable },
  ];

  const tools = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  // Primer turno: Claude ve el historial y decide si llamar una tool o responder
  let response = await llamarClaude(system, historial, tools);
  // Claude escribe texto ANTES de pedir una tool ("Un momento, chequeo..."). Ese
  // texto se junta con el de la respuesta final y se manda en un solo mensaje.
  const partes: string[] = [];
  let guard = 0;
  while (response.stop_reason === 'tool_use' && guard++ < 5) {
    for (const b of response.content ?? []) {
      if (b.type === 'text' && b.text.trim()) partes.push(b.text.trim());
    }

    // Claude puede pedir VARIAS tools en el mismo mensaje. Cada `tool_use` que llegó
    // tiene que tener su `tool_result` en el siguiente mensaje de usuario,
    // o Claude rompe con "tool_use ids were found without tool_result blocks".
    const toolUses = (response.content ?? []).filter((b: any) => b.type === 'tool_use');
    if (toolUses.length === 0) break;

    // El telefono lo pone el backend, NO el modelo
    //
    // ─── UNA POR UNA, EN ORDEN. NO EN PARALELO ───
    //
    // Esto era un `Promise.all` y por eso el bot pudo agendar dos servicios a la
    // misma hora con el mismo empleado: el cliente pidió "un corte de pelo y un
    // lavado y alisado", el modelo pidió las dos `crear_turno` en el mismo mensaje,
    // y las dos LEYERON la agenda antes de que ninguna ESCRIBIERA. Cada una vio las
    // 14:00 como libres y las dos reservaron.
    //
    // Un `Promise.all` no tiene nada de raro en un chat, donde casi siempre hay una
    // sola tool. Es acá donde muerde: las tools que escriben se pisan entre ellas
    // porque el chequeo de disponibilidad y el guardado no son atómicos.
    //
    // Consecuencia de hacerlo en serie: la segunda `crear_turno` vuelve a leer la
    // agenda, ahora con el turno recien creado, y da `horario_no_disponible`. El bot
    // recien uno y ofrece otra hora para el segundo servicio. Que es lo correcto.
    //
    // Cuesta unos cientos de milisegundos por tool de mas. Se paga.
    const resultados = [];
    for (const tu of toolUses) {
      resultados.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: await ejecutarTool(tu.name, tu.input, telefono),
      });
    }

    // Se guarda SOLO el `tool_use`, sin el texto que el modelo escribio antes de
    // pedirlo.
    //
    // El texto ya se recolecto arriba en `partes` (y `unirRespuesta` lo usa para
    // el saludo del primer mensaje). Dejarlo TAMBIEN en el historial hace que el
    // modelo lo vea como algo ya dicho y lo REPITA en la respuesta final: el
    // cliente recibe "Dejame chequear los horarios... El jueves no hay lugar",
    // todo junto, y termina leyendo el proceso. Es el mismo texto que la regla
    // del prompt ("no escribas nada antes de una tool") no logra evitar.
    historial.push({
      role: 'assistant',
      content: (response.content ?? []).filter((b: any) => b.type === 'tool_use'),
    } as any);
    historial.push({ role: 'user', content: resultados } as any);

    response = await llamarClaude(system, historial, tools);
  }

  for (const b of response.content ?? []) {
    if (b.type === 'text' && b.text.trim()) partes.push(b.text.trim());
  }

  return unirRespuesta(partes, esPrimerMensaje);
}

/**
 * Le agrega al final los links del calendario de los turnos que se acaban de crear o
 * mover, SI el modelo no los puso.
 *
 * El modelo los copia una de cada dos veces. Cuando se olvida, el cliente recibe un
 * turno confirmado sin ninguna forma de guardarlo, y no se da cuenta de que le falta
 * algo: para él la conversación terminó bien.
 *
 * La frase antes de los links la escribe el modelo (en el mensaje ya viene algo como
 * "te lo reservé"), y acá va solo una linea neutra si el mensaje no parece estar
 * pasando los links.
 */
function agregarLinksDeCalendario(texto: string): string {
  const faltan = pendientesDeCalendario.filter((c) => !yaEstanEnElTexto(texto, c));
  if (faltan.length === 0) return texto;

  const partes = [texto.trimEnd()];
  for (const c of faltan) {
    partes.push(
      `📅 Google: ${c.google}\n📅 iPhone: ${c.ics}`,
    );
  }
  return partes.join('\n\n');
}

/**
 * Junta los trozos de texto que el modelo fue dejando entre tool y tool.
 *
 * Se queda con el PRIMERO y con el ULTIMO, y tira los del medio:
 *   · el primero puede ser la presentación ("Soy el bot de X"), que antes se perdía
 *   · el último es la respuesta, ya con el resultado de la tool en la mano
 *   · los del medio son narración ("un momento", "dale, chequeo", "ahora veo si...").
 *     El cliente los lee varias veces por turno y, si la tool falla, el primero ya
 *     le anunció algo que no pasó. Filtrar "los que se repiten" no alcanza: cambian
 *     una palabra y siguen siendo relleno
 *
 * Después saca las repeticiones: dos frases iguales (salvo acentos y puntuación) son
 * la misma para el que lee, y se queda la más larga porque es la que tiene detalle.
 */
/**
 * ¿Este bloque es la PRESENTACIÓN del bot, o es narración de proceso?
 *
 * El primer bloque de la respuesta se conserva en el primer mensaje de la
 * conversación porque ahí suele estar el "¡Hola! Soy el asistente de X". El problema
 * es que a veces ese bloque es un "un momento chequeo" y no una presentación, y con
 * el criterio viejo ("conservá el primero") se mandaba igual.
 *
 * Por eso se mira QUÉ dice y no DÓNDE está: se conserva solo si se presenta. Si
 * habla de chequear, de buscar o de agendar, es proceso y no va.
 */
function esPresentacion(s: string): boolean {
  return /\b(soy|seré)\s+(el\s+)?(asistente|bot)\b/i.test(s);
}

/**
 * De un bloque que mezcla presentación y narración, quedarse solo con la
 * presentación.
 *
 * El modelo escribe a veces las dos cosas juntas en el mismo bloque antes de la
 * tool: "¡Hola! Soy el asistente de RyF Lavadero.\n\nUn momento, déjame ver los
 * horarios." Conservar el bloque entero por ser presentación volvía a mandar la
 * narración, que es justo lo que se quería sacar.
 *
 * Se parte por párrafos y se conservan los que SE PRESENTAN. El resto (el "un
 * momento", el "dale, voy viendo") se cae.
 */
function soloPresentacion(s: string): string {
  return s
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && esPresentacion(p))
    .join('\n\n');
}

function unirRespuesta(partes: string[], esPrimerMensaje = false): string {
  const utiles = partes.filter((p) => p.trim());
  if (utiles.length === 0) return 'Disculpá, no te entendí. ¿Querés que te mire un turno?';
  if (utiles.length === 1) return sinRepetir(utiles);

  // ─── Solo el ÚLTIMO bloque, salvo que el primero sea la presentación ───
  //
  // Antes se quedaban el primero y el último SIEMPRE. El primero existe por una
  // razón histórica: la presentación la escribía el modelo antes de la primera tool,
  // y al quedarnos solo con el último se perdía.
  //
  // El costo era que el cliente leía el PROCESO: cada "¿qué necesitás?", cada "un
  // momento, chequeo" y cada "dale, te lo reservo" le llegaba como un mensaje
  // aparte, dos veces por agendar. El cliente quiere la respuesta.
  //
  // Por qué no se arregla con una regla del prompt: ya la hay ("no escribas nada
  // antes de una tool") y no se cumple, porque el modelo escribe el bloque sin
  // pensar que se va a ver. Acá no depende de que se acuerde.
  // Si la respuesta final YA se presenta, no hace falta el bloque de antes: el
  // modelo repitio la presentacion despues de la tool y el cliente la leia dos
  // veces (y con ella el aviso de cierre que venia pegado).
  if (
    esPrimerMensaje &&
    esPresentacion(utiles[0]) &&
    !esPresentacion(utiles[utiles.length - 1])
  ) {
    const intro = soloPresentacion(utiles[0]);
    if (intro) return sinRepetir([intro, utiles[utiles.length - 1]]);
  }

  return sinRepetir([utiles[utiles.length - 1]]);
}

function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function sinRepetir(partes: string[]): string {
  const salida: string[] = [];
  for (const p of partes) {
    const n = normalizar(p);
    if (!n) continue;
    const yaDije = salida.findIndex((s) => {
      const m = normalizar(s);
      return m === n || m.startsWith(n + ' ') || n.startsWith(m + ' ');
    });
    if (yaDije < 0) {
      salida.push(p);
      continue;
    }
    // Misma frase: se queda la version mas larga (la que explica mas).
    if (n.length > normalizar(salida[yaDije]).length) salida[yaDije] = p;
  }

  return salida.join('\n\n') || 'Disculpá, no te entendí. ¿Querés que te mire un turno?';
}

async function llamarClaude(system: any, historial: any[], tools: any[]): Promise<any> {
  // Segundo punto de corte de caché, en el ÚLTIMO tool.
  //
  // El prefijo que Claude mira es: system -> tools -> messages. El `cache_control` del
  // system ya cachea la parte fija. Este marca el final de tools también, y ese
  // tramo SÍ se repite entre las 3 o 5 llamadas que hace un mismo mensaje de
  // WhatsApp: mismo día, mismo nombre de negocio, mismos parametros de tools.
  const toolsConCache = tools.length
    ? tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t))
    : tools;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system,
      messages: historial,
      tools: toolsConCache,
    }),
  });
  if (!r.ok) {
    const texto = await r.text();
    throw new Error(`Claude ${r.status}: ${texto.slice(0, 200)}`);
  }
  return await r.json();
}



// ─── Handler principal ───
Deno.serve(async (req) => {
  // --- Verificacion de Meta (GET /) ---
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');

    // ─── El archivo .ics del turno ───
    // Va PRIMERO porque el handler de Meta de abajo devuelve 403 para cualquier GET
    // que no sea la verificacion, y un .ics necesita un content-type propio.
    //
    // El link lo manda el bot al confirmar, apuntando a esta misma funcion: no hay
    // que subir el archivo a ningun lado ni guardar el calendario en una tabla.
    if (url.pathname.endsWith('/turno.ics')) {
      const id = Number(url.searchParams.get('i'));
      const firma = url.searchParams.get('f') ?? '';

      // Sin id, con id invalido o con la firma incorrecta: mismo 404 para todos.
      // Distinguir "no existe" de "no podes verlo" le dice a quien va probando
      // numeros cuántos turnos hay.
      const ok = Number.isInteger(id) && id > 0 && firma.length > 0 && (await firmaDeTurno(id)) === firma;
      if (!ok) return new Response('No encontrado', { status: 404 });

      const { data: t } = await sb
        .from('turnos')
        .select('id, servicio_nombre, precio, fecha, hora_inicio, hora_fin, estado')
        .eq('id', id)
        .maybeSingle();

      // Un turno cancelado se sigue escuchando (el cliente lo tiene en su
      // calendario), pero el .ics lo marca como cancelado para que se note al
      // mirarlo.
      if (!t) return new Response('No encontrado', { status: 404 });

      const ics = icsDelTurno({
        id: t.id,
        servicio_nombre: t.servicio_nombre,
        precio: t.precio,
        fecha: t.fecha,
        hora_inicio: t.hora_inicio,
        hora_fin: t.hora_fin,
        negocio: await config('nombre_negocio'),
      });

      const cancelado = t.estado === 'cancelado' ? ics.replace('STATUS:CONFIRMED', 'STATUS:CANCELLED') : ics;

      return new Response(cancelado, {
        headers: {
          // El content-type es lo que hace que iOS y Android abran el calendario en
          // vez de descargar un archivo de texto.
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': `attachment; filename="turno-${t.id}.ics"`,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    try {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    } catch (e: any) {
      return new Response('Error: ' + e?.message, { status: 500 });
    }
  }

  if (req.method !== 'POST') return new Response('OK, pero solo POST', { status: 405 });

  const body = await req.json().catch(() => null);
  if (!body) return new Response('JSON invalido', { status: 400 });

  // WhatsApp a veces manda un webhook de prueba sin messages. Si no hay, OK y listo.
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  if (!message) return new Response('Sin mensaje, OK', { status: 200 });

  /**
 * El texto que escribió la persona, venga de donde venga.
 *
 * Meta no manda el texto siempre en `text.body`. Cuando alguien manda una FOTO con
 * un comentario debajo, el texto va en `image.caption`. Con una nota de voz que
 * llega ya transcrita por el dispositivo, va en `audio.caption`. Con un PDF
 *Appointment goes in `document.caption`. Y si toca un boton de los que manda el
 * negocio, va en `interactive`.
 *
 * Antes solo se leia `text.body`, asi que una clienta que mandaba una foto de un
 * corte con "el lunes a las 10" escrito abajo recibia "Por ahora solo entiendo
 * texto": habia escrito, y el bot no lo leia. Es el caso mas comun de todos, por
 * cierto: la foto de referencia con el pedido al lado.
 */
function textoDelMensaje(message: any): string {
  const m = message ?? {};
  const limp = (v: any) => (typeof v === 'string' ? v.trim() : '');
  const candidatos: any[] = [
    m.text?.body,
    m.image?.caption,
    m.video?.caption,
    m.document?.caption,
    m.audio?.caption,
    m.button?.text,
    m.interactive?.button_reply?.title,
    m.interactive?.list_reply?.title,
  ];
  for (const c of candidatos) {
    const t = limp(c);
    if (t) return t;
  }
  return '';
}

/**
 * Transcribe una nota de voz de WhatsApp.
 *
 * Claude no escucha audios, asi que el audio se convierte en texto ANTES del
 * modelo: el bot contesta como si la persona hubiera escrito, y puede seguir
 * mandando links de calendario y horarios, que es justo lo que una respuesta de
 * voz rompe.
 *
 * Va con Groq (whisper-large-v3-turbo) porque tiene plan gratis y la API es la
 * misma que la de OpenAI. Si `GROQ_API_KEY` no esta cargada devuelve vacio y el
 * bot manda el aviso de siempre: asi la funcion se prende por proyecto.
 */
async function transcribirAudio(mediaId: string): Promise<string> {
  if (!GROQ_KEY || !mediaId) return '';

  try {
    // 1. Meta no manda el archivo: da una URL temporal (vence a los 5 minutos).
    const info = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
    });
    if (!info.ok) {
      console.error('Meta no dio el audio:', await info.text());
      return '';
    }
    const { url, mime_type } = await info.json();
    if (!url) return '';

    const archivo = await fetch(url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
    if (!archivo.ok) {
      console.error('No se pudo bajar el audio:', archivo.status);
      return '';
    }
    const bytes = await archivo.arrayBuffer();

    // 2. Mismo formato multipart que OpenAI.
    const forma = new FormData();
    forma.append('file', new Blob([bytes], { type: mime_type ?? 'audio/ogg' }), 'audio.ogg');
    forma.append('model', 'whisper-large-v3-turbo');
    forma.append('response_format', 'json');

    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: forma,
    });
    if (!r.ok) {
      console.error('Groq no transcribio:', await r.text());
      return '';
    }
    const data = await r.json();
    return String(data?.text ?? '').trim();
  } catch (e) {
    console.error('Error transcribiendo audio:', e);
    return '';
  }
}

/** Si en los ultimos 30 minutos ya le avisamos que escriba, no repetimos. */
async function avisoReciente(telefono: string): Promise<boolean> {
  const { data } = await sb
    .from('conversaciones').select('updated_at').eq('telefono', telefono).maybeSingle();
  if (!data?.updated_at) return false;
  return Date.now() - new Date(data.updated_at).getTime() < 30 * 60 * 1000;
}

/** El aviso para lo que no es texto, en el tono que eligio el negocio. */
async function mensajeSinTexto(): Promise<string> {
  const { data } = await sb.from('configuracion').select('valor').eq('clave', 'tono').maybeSingle();
  const profesional = (data?.valor ?? '').trim() === 'profesional';
  return profesional
    ? 'Recibimos tu mensaje. No podemos procesar audios ni imágenes, así que escribinos tu consulta por acá y te respondemos a la brevedad.'
    : 'Te leo! Se nos mandan las notas de voz y las imágenes pero no las podemos mirar, así que escribinos por acá qué necesitás y te ayudamos al toque.';
}

const telefono = message.from;
  const tipo = message.type;
  let texto = textoDelMensaje(message);

  // ─── El bot no se contesta a sí mismo ───
  // `display_phone_number` es el número desde el que envía el negocio. Cuando el
  // emisor es ese mismo número, lo que llegó es el mensaje que el bot mandó hace un
  // segundo, devuelto por Meta como entrante. Sin esto se guardaba en el historial
  // como si lo hubiera escrito el cliente y el bot respondía a su propia respuesta,
  // en bucle.
  const propio = value?.metadata?.display_phone_number;
  if (propio && ultimosDigitos(propio) === ultimosDigitos(telefono)) {
    return new Response('Mensaje propio, ignorado', { status: 200 });
  }
  // -- Reintentos de Meta --
  //
  // Meta vuelve a mandar el webhook cuando no recibe 200 a tiempo, y a tiempo es
  // poco: si la respuesta tarda mas de 20 segundos da el mensaje por caido. El bot
  // tarda facil eso cuando da vueltas de herramientas (buscar cliente, ver
  // servicios, ver horarios, reservar, confirmar), asi que en los turnos largos el
  // reintento es la norma y no la excepcion.
  //
  // Sin esto se procesaba dos veces. Probado mandando el mismo webhook tres veces:
  //
  //   turnos en la base: 1     <- lo salvo el resto del sistema
  //   mensajes al cliente: 4    <- los cuatro con sus cuatro links
  //
  // La clienta recibia lo mismo cuatro veces. Los datos no se rompieron porque la
  // regla de "ya tenes eso agendado" y la restriccion EXCLUDE frenaron el segundo
  // turno, pero cuatro respuestas a un solo mensaje se ven como que el bot esta
  // roto.
  //
  // `message.id` (wamid.X) es unico e inmutable por mensaje. Se inserta ANTES de
  // procesar: el que pierde el insert ya lo proceso otro, y solo contesta 200 para
  // que Meta deje de reintentar. Va antes de todo lo demas a proposito, porque si
  // el reintento llegara mientras el primero todavia esta corriendo tiene que
  // chocar con el indice y no procesar.
  const mensajeId = message.id ?? '';
  if (mensajeId) {
    const { error: errDup } = await sb
      .from('mensajes_procesados')
      .insert({ id: mensajeId, telefono });
    if (errDup) {
      return new Response('Ya procesado', { status: 200 });
    }
  }

  // ─── Nota de voz: se transcribe y sigue como si hubiera escrito ───
  // Va despues del control de reintentos: transcribir tarda unos segundos y no
  // queremos pagarlo dos veces si Meta reenvia el webhook.
  if (!texto && message.audio?.id) {
    texto = await transcribirAudio(message.audio.id);
  }

  // Un like o un emoji NO es una pregunta. Contestarle "solo entiendo texto" a
  // alguien que reaccionó es hablarle al lado, y peor: si manda tres audios seguidos
  // recibe tres veces el mismo aviso. Eso se contesta UNA vez y despues se calla.
  //
  // Los audios SÍ son un problema real: en WhatsApp la gente escribe grabando, y un
  // bot que contesta "no entiendo" a una nota de voz le deja de servir justo a la
  // mitad de sus clientas. Si `GROQ_API_KEY` esta cargada, arriba se transcriben y
  // no se llega hasta aca. Este aviso queda para cuando falla la transcripcion o
  // el proyecto no la tiene prendida, y sale con limite de uno cada media hora.
  if (!texto) {
    const tipoSinVoz = new Set(['reaction', 'sticker', 'unsupported', 'unknown']);
    if (!tipoSinVoz.has(tipo) && !(await avisoReciente(telefono))) {
      await responderWhatsApp(telefono, await mensajeSinTexto());
      // Se marca la conversacion para no repetir el aviso. Solo si NO existe: si ya
      // hay una fila es que hay una conversacion en curso, y una foto en el medio no
      // puede pisar el estado de una propuesta a medio confirmar.
      const { data: hay } = await sb
        .from('conversaciones').select('id').eq('telefono', telefono).maybeSingle();
      if (!hay) {
        await sb.from('conversaciones').insert({
          telefono,
          estado: 'aviso_sin_texto',
          updated_at: new Date().toISOString(),
        });
      }
    }
    return new Response('OK', { status: 200 });
  }

  // ─── Buscar la conversacion y su historial ───
  const { data: convo } = await sb
    .from('conversaciones')
    .select('*')
    .eq('telefono', telefono)
    .maybeSingle();

  const historial: any[] = convo?.historial_claude
    ? (() => { try { return JSON.parse(convo.historial_claude); } catch { return []; } })()
    : [];

  // Si el historial quedó roto de una prueba vieja (una tool_use sin su tool_result
  // inmediatamente después), Claude rechaza el pedido con 400 y el cliente se queda
  // sin respuesta. Se limpia acá, antes de enviárselo a Claude.
  const historialSano = sanearHistorial(historial);

  historialSano.push({ role: 'user', content: texto });

  // ─── Spec embebido. Se puede cambiar sin tocar el codigo. ───
  const spec = await obtenerSpec();

  let respuesta = '';
  try {
    // Se vacía antes de responder: los links son de ESTE turno, no de los anteriores.
    pendientesDeCalendario = [];
    respuesta = await responderAlCliente(historialSano, telefono, spec);

    // ─── Si confirmo un turno, el turno tiene que existir ───
    //
    // Va ANTES de `agregarLinksDeCalendario`: ahi se agregan los links de los turnos
    // que SI se crearon, asi que un mensaje sin links no es sospechoso. Lo que si lo
    // es un mensaje con links que ninguna tool devolvio (ver `linksInventados`).
    const inventados = linksInventados(respuesta, historialSano);
    if (inventados.length > 0) {
      console.error('Links inventados por el modelo:', inventados.join(' '));
      // Se le devuelve su propia respuesta y se le pide que corrija. El aviso NO se
      // guarda en el historial: es una nota interna, no algo que dijo el cliente.
      const paraReintento = [
        ...historialSano,
        { role: 'assistant', content: respuesta },
        { role: 'user', content: AVISO_LINKS_INVENTADOS },
      ];
      respuesta = await responderAlCliente(paraReintento, telefono, spec);

      // Si en la segunda tampoco llama a la tool, no se manda una confirmacion que
      // puede ser falsa: se lo manda al telefono del local.
      if (linksInventados(respuesta, paraReintento).length > 0) {
        respuesta = await mensajeDeFalla();
      }
    }

    respuesta = agregarLinksDeCalendario(respuesta);
  } catch (e: any) {
    falloTecnico = true;
    console.error(e);
    // El `console.error` solo lo ve el que tiene el dashboard de Supabase con los
    // logs en vivo. El que atiende en el local solo ve "se me cayó la conexión", y
    // con eso no puede distinguir entre "se cayó un segundo" y "la API key venció"
    // y "se acabaron los tokens", que son tres cosas que se arreglan distinto.
    //
    // Se escribe el mensaje crudo: si viene de Claude, trae el status y el cuerpo de
    // la respuesta, que es donde dice 401, 429 o lo que sea. Cortado a 500 porque
    // algunos errores traen HTML largo de una pasarela y esto no es un archivo de
    // log, es una fila.
    await sb
      .from('conversaciones')
      .update({ ultimo_error: String(e?.message ?? e).slice(0, 500) })
      .eq('telefono', telefono);
    // Si algo falla, al menos que el cliente tenga por donde pedir ayuda en vez de
    // quedarse mirando un "probá en unos minutos" sin salida.
    respuesta = await mensajeDeFalla();
  }

  historialSano.push({ role: 'assistant', content: respuesta });

  // Si respondió bien, no hay error pendiente: se limpia. Así la columna dice la
  // verdad, que es "el ÚLTIMO fallo", y no algo viejo de hace tres días que hace
  // creer que el bot sigue roto cuando ya anda.
  if (!falloTecnico) {
    await sb.from('conversaciones').update({ ultimo_error: null }).eq('telefono', telefono);
  }

  // ─── Guardar el historial en conversations. `historial_claude` es el espacio que
  // preparaste para esto. Si la fila no existe, se crea. ───
  const payload = { telefono, historial_claude: JSON.stringify(sanearHistorial(historialSano)) };
  const { error: errUpsert } = await sb
    .from('conversaciones')
    .upsert(payload, { onConflict: 'telefono' });
  if (errUpsert) console.error('Error guardando conversacion:', errUpsert);

  await responderWhatsApp(telefono, respuesta);
  return new Response('OK', { status: 200 });
});


// ─── Mensaje cuando algo se rompe ───
// El teléfono de emergencia se saca de `configuracion` (clave telefono_emergencia), así
// se cambia desde Configuración sin tocar código ni volver a desplegar la función.
async function mensajeDeFalla(): Promise<string> {
  const { data } = await sb.from('configuracion').select('valor').eq('clave', 'telefono_emergencia').maybeSingle();
  const tel = (data?.valor ?? '').trim();
  const base =
    'Uy, se me cayó la conexión y no pude terminar de responderte. Disculpá la molestia.';
  return tel
    ? `${base} Para no hacerte esperar, llamanos al ${tel} y te atendemos al toque.`
    : `${base} Probá en unos minutos.`;
}

// ─── Spec: se puede cargar de una tabla en el futuro. Por ahora es texto fijo. ───
async function obtenerSpec(): Promise<string> {
  return `Rotina de atencion:
1. Cuando el cliente saluda, o antes de agendar, llama buscar_cliente. Si devuelve un nombre, saludalo por su nombre y NO le pidas el nombre otra vez: crear_turno lo resuelve solo. Si no devuelve nada, es un cliente nuevo y ahi si se lo pides, SIEMPRE nombre y apellido juntos ("¿Me pasás tu nombre y apellido?"), nunca solo el nombre.
2. Si el cliente viene por un turno nuevo, pedile el servicio. PERO si la pregunta es de GENTE ("quien trabaja mañana", "quien esta el jueves"), no le pidas servicio: llamá empleados_del_dia con la fecha y respondé quién trabaja y en qué horario. Son preguntas distintas y reconducir la segunda a la primera hace que el cliente se enrede.
3. Cuando elija servicio, mostra los horarios libres con consultar_horarios_libres.
4. Si elige horario, crealo con crear_turno.
5. Si quiere cancelar o reprogramar, primero buscar_turnos_cliente. Cada turno que devuelve esa tool trae se_puede_mover: ofrecele mover o cancelar SOLO los que vienen con true. Los que vienen con false ya no se tocan (ya pasaron, o falta menos que el plazo de cancelacion): decile el motivo tal cual y no le preguntes que quiere hacer con ese turno, porque la tool te lo va a rechazar y el cliente ya se ilusiono con un cambio que no existe. Si quiere cambiar la fecha o la hora de un turno que ya tiene, se reprograma con reprogramar_turno (primero le decis a que turno se refiere, con buscar_turnos_cliente, y le mostras el horario nuevo antes de llamar a la tool). Si el turno que quiere tocar ya paso, no se reprograma: se agenda uno nuevo. Cuando un turno no se puede mover ni cancelar, el motivo o el error traen el telefono del local: pasaselo en la misma respuesta. No lo mandes a "comunicarse con el local" sin darle el numero.

6. Si te preguntan por la direccion, los dias cerrados o el telefono del local, responde con obtener_config_negocio (clave direccion, dias_cerrados, telefono_emergencia). Los horarios de atencion ya estan en tu contexto, en la linea "Horarios de atencion": usalos tal cual y no llames una tool para eso. Si la tool vuelve con configurado:false, esa informacion NO esta cargada: decilo con esas palabras y segui. No la completes, no le des un valor aproximado, y no le sugieras otro canal (redes, mail, un telefono que no te dieron): no tenes de donde sacarlo. Cualquier otra cosa que te pregunten que no sea del local: una linea, y seguí con los turnos (ver "QUE SABES Y QUE NO").
7. Si listar_servicios vuelve vacio:true, no pidas nombre ni digas que vas a agendar: no hay nada que agendar. Decile al cliente que todavia no hay servicios cargados en el local.

IMPORTANTE sobre las fechas: no le pidas al cliente la fecha en formato yyyy-MM-dd. Entende 'el domingo que viene', 'pasado manana', 'el 11 de octubre' a partir de la fecha de hoy (esta en el system prompt). Si falta el año y el dia ya hay pasado este año, usa el año siguiente. Nunca digas 'hubiera un problema del lado del sistema' si una tool devuelve un error: explicale al cliente qué paso y ofrecele alternativas.`;
}

// ─── Enviar un mensaje de texto por la Cloud API de WhatsApp ───
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Saca el markdown antes de mandar.
 *
 * El texto de WhatsApp NO renderiza markdown: lo que sale con `**negrita**` llega
 * al cliente con los asteriscos puestos, y "📅 **Mañana, miércoles 14**" se ve como
 * un error. Claude usa markdown por costumbre (es un modelo de API, no de chat), asi
 * que hay que limpiarlo en el borde, no en el prompt: prometerle "no uses markdown"
 * funciona la mitad de las veces.
 *
 * Lo que se saca: negrita, cursiva,:tachado`, codigo, y los encabezados. Las listas
 * con `-` o `*` al principio se dejan: el guion se lee bien y las viñetas no molestan.
 */
function sinMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|\s)_([^_\n]+)_/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    // Los espacios de relleno que deja el markdown al armar tablas o listas
    .replace(/[ \t]{2,}\n/g, '\n');
}

async function responderWhatsApp(telefono: string, texto: string) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.error('FALTA WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID');
    return;
  }
  texto = sinMarkdown(texto);
  // Meta en Argentina: el webhook te entrega el "from" con el 9 (5493815512745),
  // pero la lista de destinatarios permitidos del caso de uso de prueba suele estar
  // sin el 9 (543815512745). Si la primera forma falla con 131030, probamos la otra.
  const alternativas = [telefono];
  if (telefono.startsWith('549')) alternativas.push('54' + telefono.slice(3));

  for (const to of alternativas) {
    // Meta tira 131005 "Access denied" de forma momentanea aunque el token este bien
    // (le pasa al token recien generado, mientras los permisos se propagan). Antes el
    // bot se rendia al primer error y el cliente se quedaba sin respuesta, asi que
    // ahora se reintenta con espera.
    for (let intento = 1; intento <= 3; intento++) {
      try {
        const r = await fetch('https://graph.facebook.com/v21.0/' + WA_PHONE_ID + '/messages', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: to,
            type: 'text',
            text: { body: texto },
          }),
        });

        if (r.ok) {
          if (intento > 1) console.log(`WA ok a ${to} en el intento ${intento}`);
          return;
        }

        const cuerpo = await r.text();
        console.error(`WA error (to=${to}, intento ${intento}):`, cuerpo.slice(0, 300));

        // Numero no autorizado: probar la otra variante, no tiene sentido insistir.
        if (cuerpo.includes('131030')) break;

        // Token vencido o revocado: reintentar es perder el tiempo.
        if (cuerpo.includes('"code":190') || cuerpo.includes('invalid_token')) {
          console.error('El token de Meta no sirve. Hay que generar uno nuevo.');
          return;
        }

        if (intento < 3) await dormir(1000 * intento);
      } catch (e: any) {
        // Caida de red: vale la pena reintentar.
        console.error(`WA exception (to=${to}, intento ${intento}):`, e?.message ?? e);
        if (intento < 3) await dormir(1000 * intento);
      }
    }
  }
  console.error('No se pudo entregar la respuesta por WhatsApp.');
}
