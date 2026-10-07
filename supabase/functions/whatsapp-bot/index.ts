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

const URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC = Deno.env.get('ANTHROPIC_API_KEY')!;
const WA_TOKEN = Deno.env.get('WHATSAPP_TOKEN') ?? '';
const WA_PHONE_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') ?? '';
const VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN') ?? '';

const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });

// ─── Tools, con sus descripciones para el modelo ───
// El nombre va con guion bajo porque Anthropic no acepta guionesmedios en los nombres
// de tools. La descripcion le dice al modelo QUE hace y CUANDO la usa.
const TOOLS = [
  {
    name: 'obtener_config_negocio',
    description: 'Obtiene una clave de la configuracion del negocio: nombre_negocio, tono, horas_limite_cancelacion, horario_atencion, dias_cerrados, recordatorio_cuando, recordatorio_hora.',
    input_schema: { type: 'object', properties: { clave: { type: 'string' } }, required: ['clave'] },
  },
  {
    name: 'listar_servicios',
    description: 'Devuelve la lista de servicios disponibles con id, nombre, duracion en minutos y precio.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'buscar_empleados',
    description: 'Devuelve la lista de empleados activos. Si el cliente elige uno, usa su id en crear_turno.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'consultar_horarios_libres',
    description: 'Devuelve los horarios libres para un servicio y fecha. Si no hay, incluye motivo (dia_cerrado o sin_disponibilidad).',
    input_schema: {
      type: 'object',
      properties: {
        servicio_id: { type: 'number' },
        fecha: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['servicio_id', 'fecha'],
    },
  },
  {
    name: 'crear_turno',
    description: 'Crea un turno despues de que el cliente confirmo. Requiere nombre, servicio, fecha y hora. Si no tiene disponible ese horario, devuelve error.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_cliente: { type: 'string' },
        servicio_id: { type: 'number' },
        fecha_hora: { type: 'string', description: 'ISO 8601, zona del negocio' },
        empleado_id: { type: 'number' },
      },
      required: ['nombre_cliente', 'servicio_id', 'fecha_hora'],
    },
  },
  {
    name: 'buscar_turnos_cliente',
    description: 'Busca los turnos de el cliente (por su telefono de WhatsApp). solo_futuros=true para que solo devuelva lo que viene.',
    input_schema: {
      type: 'object',
      properties: { solo_futuros: { type: 'boolean' } },
      required: ['solo_futuros'],
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
    description: 'Cambia la fecha/hora de un turno. Si el nuevo horario no esta libre o esta fuera de plazo, devuelve error.',
    input_schema: {
      type: 'object',
      properties: { turno_id: { type: 'number' }, nueva_fecha_hora: { type: 'string' } },
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

async function esDiaCerrado(fecha: string): Promise<boolean> {
  const { data } = await sb
    .from('dias_cerrados')
    .select('id')
    .lte('fecha', fecha)
    .or(`fecha_hasta.gte.${fecha},fecha_hasta.is.null`);
  return (data ?? []).length > 0;
}

async function horasMinCancelar(): Promise<number> {
  const { data } = await sb.from('configuracion').select('valor').eq('clave', 'horas_limite_cancelacion').single();
  return Number(data?.valor) || 12;
}

// ─── Ejecutar la tool que eligio el modelo ───
async function ejecutarTool(nombre: string, input: any, telefono: string): Promise<string> {
  switch (nombre) {
    case 'obtener_config_negocio': {
      const { data } = await sb.from('configuracion').select('valor').eq('clave', input.clave).single();
      return JSON.stringify({ ok: true, valor: data?.valor ?? null });
    }
    case 'listar_servicios': {
      const { data } = await sb.from('servicios').select('id, nombre, duracion_minutos, precio').eq('activo', true).order('nombre');
      return JSON.stringify({ ok: true, servicios: data ?? [] });
    }
    case 'buscar_empleados': {
      const { data } = await sb.from('empleados').select('id, nombre').eq('activo', true).order('nombre');
      return JSON.stringify({ ok: true, empleados: data ?? [] });
    }
    case 'consultar_horarios_libres': {
      const fecha = input.fecha;
      // 1. cerrado? (`fecha` es el inicio, `fecha_hasta` el final; si no hay, fue un día solo)
      const { data: cerrados } = await sb.from('dias_cerrados').select('id').lte('fecha', fecha).or(`fecha_hasta.gte.${fecha},fecha_hasta.is.null`);
      if ((cerrados ?? []).length > 0) return JSON.stringify({ ok: false, error: 'dia_cerrado' });

      // 2. dia de la semana
      const d = new Date(fecha + 'T00:00:00');
      const diaSemana = d.getDay();
      const { data: horarios } = await sb.from('horarios_atencion').select('hora_inicio, hora_fin').eq('dia_semana', diaSemana).eq('activo', true);
      if (!horarios || horarios.length === 0) return JSON.stringify({ ok: false, error: 'dia_cerrado' });

      const [hi, hf] = [horarios[0].hora_inicio, horarios[0].hora_fin];

      // 3. turnos de ese dia
      const { data: ocupados } = await sb
        .from('turnos')
        .select('hora_inicio, duracion_minutos, empleado_id')
        .eq('fecha', fecha)
        .neq('estado', 'cancelado');

      const bloques: Array<{ inicio: number; fin: number }> = (ocupados ?? []).map((t: any) => {
        const ini = horaAMin(t.hora_inicio);
        return { inicio: ini, fin: ini + (t.duracion_minutos || 30) };
      });

      // 4. ausencias del dia
      const { data: ausencias } = await sb
        .from('ausencias')
        .select('hora_inicio, hora_fin, tipo')
        .lte('desde', fecha)
        .gte('hasta', fecha);
      const vacados: Array<{ inicio: number; fin: number }> = (ausencias ?? []).map((a: any) => ({
        inicio: horaAMin(a.hora_inicio ?? '00:00'),
        fin: horaAMin(a.hora_fin ?? '23:59'),
      }));

      // 5. generar slots de 30 min entre inicio y fin que no choquen con turno ni ausencia
      const libres: string[] = [];
      let cur = horaAMin(hi);
      const fin = horaAMin(hf);
      while (cur + 30 <= fin) {
        const chocaTurno = bloques.some((b) => cur >= b.inicio && cur < b.fin);
        const chocaAusencia = vacados.some((v) => cur >= v.inicio && cur < v.fin);
        if (!chocaTurno && !chocaAusencia) libres.push(minAHora(cur));
        cur += 30;
      }

      return JSON.stringify({ ok: true, libres, dia: fecha, inicio: hi, fin: hf });
    }
    case 'crear_turno': {
      const { nombre_cliente, servicio_id, fecha_hora, empleado_id } = input;
      // 1. fecha y hora coherentes
      const dt = new Date(fecha_hora);
      if (isNaN(dt.getTime())) return err('fecha_invalida', fecha_hora);
      if (dt.getTime() < Date.now()) return err('fuera_de_horario', 'La fecha/hora ya pasaron.');

      const [fecha, hora] = fecha_hora.split('T');

      // 2. cerrado?
      const { data: cerrados } = await sb.from('dias_cerrados').select('id').lte('fecha', fecha).or(`fecha_hasta.gte.${fecha},fecha_hasta.is.null`);
      if ((cerrados ?? []).length > 0) return err('fuera_de_horario', 'Ese día el negocio no atiende.');

      // 3. servicio existe
      const { data: serv } = await sb.from('servicios').select('id, nombre, duracion_minutos, precio').eq('id', servicio_id).single();
      if (!serv) return err('servicio_no_encontrado');

      // 4. dentro de horario de atencion?
      const diaSemana = new Date(fecha + 'T00:00:00').getDay();
      const { data: horarios } = await sb.from('horarios_atencion').select('hora_inicio, hora_fin').eq('dia_semana', diaSemana).eq('activo', true);
      if (!horarios || horarios.length === 0) return err('fuera_de_horario', 'Ese dia no atienden.');
      const [hi, hf] = [horarios[0].hora_inicio, horarios[0].hora_fin];
      if (horaAMin(hora) < horaAMin(hi) || horaAMin(hora) >= horaAMin(hf)) return err('fuera_de_horario', `Atendemos ${hi}–${hf}.`);

      // 5. no choca con turno ya tomado
      const horaInicio = hora.slice(0, 5);
      const { data: choque } = await sb
        .from('turnos')
        .select('id')
        .eq('fecha', fecha)
        .eq('hora_inicio', horaInicio)
        .neq('estado', 'cancelado')
        .maybeSingle();
      if (choque) return err('horario_no_disponible', 'Ese horario ya lo tiene otro cliente.');

      // 6. falta poco para el turno?
      // (este numero lo reusa cancelar_turno, no crear)

      // Insert: id empleado libre, o el que elija el cliente.
      const emp = empleado_id
        ? (await sb.from('empleados').select('id').eq('id', empleado_id).single()).data
        : (await sb.from('empleados').select('id').eq('activo', true).order('nombre').limit(1).single()).data;

      const { data: nuevo, error: errIns } = await sb.from('turnos').insert({
        cliente_nombre: nombre_cliente,
        cliente_telefono: telefono,
        fecha,
        hora: horaInicio,
        hora_inicio: horaInicio,
        duracion_minutos: serv.duracion_minutos,
        servicio_id: serv.id,
        servicio_nombre: serv.nombre,
        precio: serv.precio,
        estado: 'pendiente',
        empleado_id: emp?.id ?? null,
      }).select('id').single();

      if (errIns) return err('error_creando_turno', errIns.message);
      return JSON.stringify({ ok: true, turno_id: nuevo.id, empleado_id: emp?.id ?? null });
    }
    case 'buscar_turnos_cliente': {
      const { data } = await sb
        .from('turnos')
        .select('id, fecha, hora, servicio_nombre, estado, empleado_id')
        .eq('cliente_telefono', telefono)
        .order('fecha', { ascending: false })
        .limit(20);
      let resultado = data ?? [];
      if (input.solo_futuros) {
        const hoy = new Date().toISOString().slice(0, 10);
        resultado = resultado.filter((t: any) => t.fecha >= hoy && t.estado !== 'cancelado');
      }
      return JSON.stringify({ ok: true, turnos: resultado });
    }
    case 'cancelar_turno': {
      const { turno_id } = input;
      const { data: turno } = await sb.from('turnos').select('fecha, hora_inicio, estado').eq('id', turno_id).single();
      if (!turno) return err('turno_no_encontrado');
      if (turno.estado === 'cancelado') return err('ya_cancelado');

      const minsFaltan = (new Date(turno.fecha + 'T' + turno.hora_inicio).getTime() - Date.now()) / 60000;
      const minsMin = (await horasMinCancelar()) * 60;
      if (minsFaltan < minsMin) return err('fuera_de_plazo', `Se cancela hasta ${minsMin / 60} hs antes.`);

      const { error } = await sb.from('turnos').update({ estado: 'cancelado' }).eq('id', turno_id);
      if (error) return err('error_cancelando', error.message);
      return JSON.stringify({ ok: true });
    }
    case 'reprogramar_turno': {
      const { turno_id, nueva_fecha_hora } = input;
      const { data: turno } = await sb.from('turnos').select('fecha, hora_inicio, estado, servicio_id, duracion_minutos').eq('id', turno_id).single();
      if (!turno) return err('turno_no_encontrado');
      if (turno.estado === 'cancelado') return err('turno_cancelado');

      const minsFaltan = (new Date(turno.fecha + 'T' + turno.hora_inicio).getTime() - Date.now()) / 60000;
      const minsMin = (await horasMinCancelar()) * 60;
      if (minsFaltan < minsMin) return err('fuera_de_plazo', `Se reprograma hasta ${minsMin / 60} hs antes.`);

      const dt = new Date(nueva_fecha_hora);
      if (isNaN(dt.getTime())) return err('fecha_invalida');
      if (dt.getTime() < Date.now()) return err('fuera_de_horario', 'La fecha ya paso.');

      const nuevaFecha = nueva_fecha_hora.split('T')[0];
      const nuevaHora = nueva_fecha_hora.split('T')[1].slice(0, 5);

      // choque con otro turno?
      const { data: choque } = await sb
        .from('turnos')
        .select('id')
        .eq('fecha', nuevaFecha)
        .eq('hora_inicio', nuevaHora)
        .neq('id', turno_id)
        .neq('estado', 'cancelado')
        .maybeSingle();
      if (choque) return err('horario_no_disponible');

      const { error } = await sb.from('turnos').update({ fecha: nuevaFecha, hora: nuevaHora + ':00', hora_inicio: nuevaHora + ':00' }).eq('id', turno_id);
      if (error) return err('error_reprogramando', error.message);
      return JSON.stringify({ ok: true });
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

// ─── Llamar a Claude con el historial y las tools ───
async function responderAlCliente(historial: any[], telefono: string, spec: string): Promise<string> {
  const system = `Sos el asistente por WhatsApp del lavadero. Hablás en español rioplatense, corto y amable. Nunca confirmás un turno sin haber llamado a crear_turno y que haya devuelto ok. Si una tool devuelve un error, explicateselo al cliente y ofrecé alternativas.

${spec}`;

  const tools = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  // Primer turno: Claude ve el historial y decide si llamar una tool o responder
  let response = await llamarClaude(system, historial, tools);
  let guard = 0;
  while (response.stop_reason === 'tool_use' && guard++ < 5) {
    const toolUse = response.content.find((b: any) => b.type === 'tool_use');
    if (!toolUse) break;

    // El telefono lo pone el backend, NO el modelo
    const resultado = await ejecutarTool(toolUse.name, toolUse.input, telefono);

    historial.push({ role: 'assistant', content: response.content } as any);
    historial.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: resultado }] } as any);

    response = await llamarClaude(system, historial, tools);
  }

  const respuestaTexto = response.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n') || 'Disculpá, no te entendí. ¿Querés que te mire un turno?';

  return respuestaTexto;
}

async function llamarClaude(system: string, historial: any[], tools: any[]): Promise<any> {
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
      tools,
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
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
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

  const telefono = message.from;
  const tipo = message.type;
  const texto = message.text?.body?.trim() ?? '';

  // Meta manda mensajes que no son texto (imagen, audio, etc). Se responde con un guion.
  if (tipo !== 'text' || !texto) {
    await responderWhatsApp(telefono, 'Por ahora solo entiendo texto.');
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

  historial.push({ role: 'user', content: texto });

  // ─── Spec embebido. Se puede cambiar sin tocar el codigo. ───
  const spec = await obtenerSpec();

  let respuesta = '';
  try {
    respuesta = await responderAlCliente(historial, telefono, spec);
  } catch (e: any) {
    console.error(e);
    respuesta = 'Hubo un problema del lado del sistema. Probá en unos minutos.';
  }

  historial.push({ role: 'assistant', content: respuesta });

  // ─── Guardar el historial en conversations. `historial_claude` es el espacio que
  // preparaste para esto. Si la fila no existe, se crea. ───
  const payload = { telefono, historial_claude: JSON.stringify(historial) };
  const { error: errUpsert } = await sb
    .from('conversaciones')
    .upsert(payload, { onConflict: 'telefono' });
  if (errUpsert) console.error('Error guardando conversacion:', errUpsert);

  await responderWhatsApp(telefono, respuesta);
  return new Response('OK', { status: 200 });
});


// ─── Spec: se puede cargar de una tabla en el futuro. Por ahora es texto fijo. ───
async function obtenerSpec(): Promise<string> {
  return `Rotina de atencion:
1. Si el cliente viene por un turno nuevo, pedile el servicio.
2. Cuando elija servicio, mostra los horarios libres con consultar_horarios_libres.
3. Si elige horario, confirmar y pedir nombre.
4. Crear turno con crear_turno.
5. Si quiere cancelar o reprogramar, primero buscar_turnos_cliente.`;
}

// ─── Enviar un mensaje de texto por la Cloud API de WhatsApp ───
async function responderWhatsApp(telefono: string, texto: string) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.error('FALTA WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID');
    return;
  }
  const r = await fetch('https://graph.facebook.com/v21.0/' + WA_PHONE_ID + '/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'text',
      text: { body: texto },
    }),
  });
  if (!r.ok) console.error('WA error:', await r.text());
}
