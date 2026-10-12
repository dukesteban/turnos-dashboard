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
const VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN') ?? '';

const sb = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

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
    name: 'buscar_cliente',
    description:
      'Devuelve el cliente ya registrado con el numero desde el que escribe el cliente (id, nombre). Llamala PRIMERO, antes de pedirle el nombre: si ya existe, saludalo por su nombre y no se lo vuelvas a preguntar. Si devuelve null, es un cliente nuevo y hay que pedirle el nombre.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'crear_turno',
    description:
      'Crea un turno despues de que el cliente confirmo. Si el cliente ya estaba registrado, no hace falta pasarle nombre_cliente (se resuelve solo por el numero). Si no tiene disponible ese horario, devuelve error.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_cliente: { type: 'string', description: 'Solo si el cliente es nuevo o quiere corregirse.' },
        servicio_id: { type: 'number' },
        fecha_hora: { type: 'string', description: 'ISO 8601, zona del negocio' },
        empleado_id: { type: 'number' },
      },
      required: ['servicio_id', 'fecha_hora'],
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

function diaCerrado(cerrados: Array<{ fecha: string; fecha_hasta?: string | null }>, fecha: string): boolean {
  // Un día cerrado sin fecha_hasta aplica SOLO ese día. Con fecha_hasta, aplica todo el
  // rango. La condición anterior (`lte(fecha) + or(fecha_hasta >= x, is null)`) contaba
  // COMO CERRADOS POR SIEMPRE los que tenían fecha_hasta NULL, porque esa cláusula
  // matchea cualquier fecha posterior a la del cierre.
  const D = new Date(fecha + 'T00:00:00').getTime();
  return (cerrados ?? []).some((c: any) => {
    const desde = new Date(c.fecha + 'T00:00:00').getTime();
    const hasta = c.fecha_hasta ? new Date(c.fecha_hasta + 'T00:00:00').getTime() : desde;
    return desde <= D && D <= hasta;
  });
}

async function horasMinCancelar(): Promise<number> {
  const { data } = await sb.from('configuracion').select('valor').eq('clave', 'horas_limite_cancelacion').single();
  return Number(data?.valor) || 12;
}

type Bloque = { inicio: number; fin: number };

function sePisan(a: Bloque, b: Bloque): boolean {
  return a.inicio < b.fin && b.inicio < a.fin;
}

// ─── Como esta el dia empleado por empleado ───
// Devuelve, para cada franja, quien puede tomar el turno. Si nadie esta libre en una
// franja, el horario no se ofrece: asi el bot nunca agenda a alguien que ya esta ocupado.
async function estadoDelDia(fecha: string) {
  const [{ data: empleados }, { data: turnos }, { data: ausencias }] = await Promise.all([
    sb.from('empleados').select('id, nombre').eq('activo', true).order('nombre'),
    sb.from('turnos')
      .select('hora_inicio, hora_fin, duracion_minutos, empleado_id')
      .eq('fecha', fecha)
      .neq('estado', 'cancelado'),
    sb
      .from('ausencias')
      .select('empleado_id, hora_inicio, hora_fin')
      .lte('desde', fecha)
      .gte('hasta', fecha),
  ]);

  const todos = empleados ?? [];

  // Un turno sin hora_fin (los viejos del bot) cae a hora_inicio + duracion.
  const agenda = new Map<number, Bloque[]>();
  for (const t of turnos ?? []) {
    if (!t.empleado_id) continue;
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

  const libres = (empleadoId: number, desde: number, hasta: number): boolean =>
    !(agenda.get(empleadoId) ?? []).some((b) => sePisan({ inicio: desde, fin: hasta }, b));

  return {
    empleados: todos,
    libres,
    algunoLibre: (desde: number, hasta: number) => todos.some((e: any) => libres(e.id, desde, hasta)),
    // el primero que puede tomar ese horario, o null si esta todo lleno
    quienPuede: (desde: number, hasta: number, preferido?: number | null) => {
      if (preferido != null && libres(preferido, desde, hasta)) return preferido;
      const otro = todos.find((e: any) => libres(e.id, desde, hasta));
      return otro ? otro.id : null;
    },
  };
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
          .order('dia_semana', { ascending: true });
        return JSON.stringify({ ok: true, valor: data ?? [] });
      }
      if (input.clave === 'dias_cerrados') {
        const { data } = await sb.from('dias_cerrados').select('fecha, motivo, fecha_hasta').order('fecha', { ascending: true });
        return JSON.stringify({ ok: true, valor: data ?? [] });
      }
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
      const { data: cerrados } = await sb.from('dias_cerrados').select('fecha, fecha_hasta');
      if (diaCerrado(cerrados ?? [], fecha)) return JSON.stringify({ ok: false, error: 'dia_cerrado' });

      // 2. dia de la semana
      const d = new Date(fecha + 'T00:00:00');
      const diaSemana = d.getDay();
      const { data: horarios } = await sb.from('horarios_atencion').select('hora_inicio, hora_fin').eq('dia_semana', diaSemana).eq('activo', true);
      if (!horarios || horarios.length === 0) return JSON.stringify({ ok: false, error: 'dia_cerrado' });

      const [hi, hf] = [horarios[0].hora_inicio, horarios[0].hora_fin];

      // 3. la duracion la manda el servicio, no un slot fijo de 30 min
      const { data: serv } = await sb.from('servicios').select('id, nombre, duracion_minutos').eq('id', input.servicio_id).single();
      const duracion = serv?.duracion_minutos || 30;

      // 4. estado del dia, POR EMPLEADO. Un horario esta libre si hay AL MENOS UN
      //    empleado sin nada encima en esa franja: antes se miraba el negocio entero
      //    como un bloque, asi que un turno de uno tapaba los horarios de todos.
      const agenda = await estadoDelDia(fecha);

      // 5. slots cada 30 min que entren completos dentro del horario
      const libres: string[] = [];
      let cur = horaAMin(hi);
      const fin = horaAMin(hf);
      while (cur + duracion <= fin) {
        if (agenda.algunoLibre(cur, cur + duracion)) libres.push(minAHora(cur));
        cur += 30;
      }

      return JSON.stringify({
        ok: true,
        libres,
        dia: fecha,
        inicio: hi,
        fin: hf,
        duracion_minutos: duracion,
        nota: 'Son horarios para el servicio elegido, no para el dia entero.',
      });
    }
    case 'crear_turno': {
      const { nombre_cliente, servicio_id, fecha_hora, empleado_id } = input;
      // 0. resolver el cliente por numero. Si ya existe se usa su nombre de la base y no
      //    hace falta que el modelo lo haya preguntado. Si no, se crea con el nombre dado.
      const { data: yaExiste } = await sb.rpc('buscar_cliente_por_telefono', { p_telefono: telefono });
      const previo = (yaExiste ?? [])[0];
      if (!previo && !nombre_cliente) return err('falta_nombre', 'El cliente es nuevo y no dijo su nombre.');
      const nombreFinal = previo?.nombre ?? nombre_cliente;
      const clienteId = previo?.id ?? null;
      // 1. fecha y hora coherentes
      const dt = new Date(fecha_hora);
      if (isNaN(dt.getTime())) return err('fecha_invalida', fecha_hora);
      if (dt.getTime() < Date.now()) return err('fuera_de_horario', 'La fecha/hora ya pasaron.');

      const [fecha, hora] = fecha_hora.split('T');

      // 2. cerrado?
      const { data: cerradosCr } = await sb.from('dias_cerrados').select('fecha, fecha_hasta');
      if (diaCerrado(cerradosCr ?? [], fecha)) return err('fuera_de_horario', 'Ese día el negocio no atiende.');

      // 3. servicio existe
      const { data: serv } = await sb.from('servicios').select('id, nombre, duracion_minutos, precio').eq('id', servicio_id).single();
      if (!serv) return err('servicio_no_encontrado');

      // 4. dentro de horario de atencion, y que el servicio TERMINE antes del cierre
      const diaSemana = new Date(fecha + 'T00:00:00').getDay();
      const { data: horarios } = await sb.from('horarios_atencion').select('hora_inicio, hora_fin').eq('dia_semana', diaSemana).eq('activo', true);
      if (!horarios || horarios.length === 0) return err('fuera_de_horario', 'Ese dia no atienden.');
      const [hi, hf] = [horarios[0].hora_inicio, horarios[0].hora_fin];
      const horaInicio = hora.slice(0, 5);
      const desde = horaAMin(horaInicio);
      const hasta = desde + serv.duracion_minutos;
      if (desde < horaAMin(hi) || hasta > horaAMin(hf))
        return err('fuera_de_horario', `Atendemos ${hi}–${hf} y ese servicio dura ${serv.duracion_minutos} min.`);

      // 5. que haya un empleado LIBRE en esa franja. Antes se comparaba solo la hora
      //    exacta de inicio, asi que un lavado de 45 min a las 10:00 no bloqueaba un
      //    turno de 60 min a las 10:30 (se pisaban), y el empleado salia siempre el
      //    primero del abecedario sin mirar si estaba ocupado.
      const agenda = await estadoDelDia(fecha);
      const empId = agenda.quienPuede(desde, hasta, empleado_id ?? null);
      if (empId == null) return err('horario_no_disponible', 'Ese horario esta tomado. Ofrecele otro.');

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

      const { data: nuevo, error: errIns } = await sb.from('turnos').insert({
        cliente_id: clienteIdFinal,
        cliente_nombre: nombreFinal,
        cliente_telefono: telefono,
        fecha,
        hora: horaInicio,
        hora_inicio: horaInicio,
        // hora_fin es lo que usa la agenda para dibujar el bloque: sin esto el turno
        // queda en null y no se ve bien en el panel
        hora_fin: minAHora(hasta),
        duracion_minutos: serv.duracion_minutos,
        servicio_id: serv.id,
        servicio_nombre: serv.nombre,
        precio: serv.precio,
        estado: 'pendiente',
        empleado_id: empId,
      }).select('id').single();

      if (errIns) return err('error_creando_turno', errIns.message);
      const { data: quien } = await sb.from('empleados').select('nombre').eq('id', empId).maybeSingle();
      return JSON.stringify({
        ok: true,
        turno_id: nuevo.id,
        empleado_id: empId,
        empleado_nombre: quien?.nombre ?? null,
        cliente_id: clienteIdFinal,
        cliente_nombre: nombreFinal,
      });
    }
    case 'buscar_turnos_cliente': {
      // `cliente_telefono` esta desnormalizado y guardado con el formato viejo (549 sin el
      // 9 a veces, con el 9 otras). Buscar por `cliente_id` es lo unico confiable: el
      // numero se resuelve una vez contra `clientes`/`telefonos`, que ya normalizan.
      const { data: cli } = await sb.rpc('buscar_cliente_por_telefono', { p_telefono: telefono });
      const clienteId = (cli ?? [])[0]?.id ?? null;

      const { data } = await sb
        .from('turnos')
        .select('id, fecha, hora, servicio_nombre, estado, empleado_id')
        .eq(clienteId ? 'cliente_id' : 'cliente_telefono', clienteId ?? telefono)
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

// ─── Llamar a Claude con el historial y las tools ───
async function responderAlCliente(historial: any[], telefono: string, spec: string): Promise<string> {
  const system = `Sos el asistente por WhatsApp del lavadero. Español rioplatense, corto y amable. Hoy es ${new Date().toISOString().slice(0, 10)}. Tool de verdad antes de afirmar: nunca confirmás turno sin que crear_turno te devuelva ok, y nunca decís que un horario está libre sin antes llamar consultar_horarios_libres. Si una tool devuelve error, le explicás al cliente qué pasó y ofrecés otro camino.

Reglas de UX: cuando consultes los horarios de un día, damos como mucho 3-4 opciones para que el cliente elija, y no listees todas las libres de golpe. Si el día está cerrado, explicalo sin motivo si no lo hay, y ofrecés otro día. Nunca digas que un día está cerrado sin antes llamar consultar_horarios_libres o haber leído dias_cerrados. Al saludar, si buscar_cliente te dio un nombre, usalo: el cliente ya está registrado y no hay que pedirle el nombre. NUNCA menciones los turnos que tiene el cliente salvo que los hayas leído recién con buscar_turnos_cliente en ESTE mensaje: no los recuerdes de mensajes anteriores, pueden haber sido cancelados o borrados. Si el cliente eligió una hora que no estaba entre las que ofreciste, no digas que la reservaste sin llamar crear_turno.

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
    // Claude puede pedir VARIAS tools en el mismo mensaje. Cada `tool_use` que llegó
    // tiene que tener su `tool_result` en el siguiente mensaje de usuario,
    // o Claude rompe con "tool_use ids were found without tool_result blocks".
    const toolUses = (response.content ?? []).filter((b: any) => b.type === 'tool_use');
    if (toolUses.length === 0) break;

    // El telefono lo pone el backend, NO el modelo
    const resultados = await Promise.all(
      toolUses.map(async (tu: any) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: await ejecutarTool(tu.name, tu.input, telefono),
      })),
    );

    historial.push({ role: 'assistant', content: response.content } as any);
    historial.push({ role: 'user', content: resultados } as any);

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
    try {
      const url = new URL(req.url, 'http://localhost');
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

  // Si el historial quedó roto de una prueba vieja (una tool_use sin su tool_result
  // inmediatamente después), Claude rechaza el pedido con 400 y el cliente se queda
  // sin respuesta. Se limpia acá, antes de enviárselo a Claude.
  const historialSano = sanearHistorial(historial);

  historialSano.push({ role: 'user', content: texto });

  // ─── Spec embebido. Se puede cambiar sin tocar el codigo. ───
  const spec = await obtenerSpec();

  let respuesta = '';
  try {
    respuesta = await responderAlCliente(historialSano, telefono, spec);
  } catch (e: any) {
    console.error(e);
    respuesta = 'Hubo un problema del lado del sistema. Probá en unos minutos.';
  }

  historialSano.push({ role: 'assistant', content: respuesta });

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


// ─── Spec: se puede cargar de una tabla en el futuro. Por ahora es texto fijo. ───
async function obtenerSpec(): Promise<string> {
  return `Rotina de atencion:
1. Cuando el cliente saluda, o antes de agendar, llama buscar_cliente. Si devuelve un nombre, saludalo por su nombre y NO le pidas el nombre otra vez: crear_turno lo resuelve solo. Si no devuelve nada, es un cliente nuevo y ahi si se lo pides.
2. Si el cliente viene por un turno nuevo, pedile el servicio.
3. Cuando elija servicio, mostra los horarios libres con consultar_horarios_libres.
4. Si elige horario, crealo con crear_turno.
5. Si quiere cancelar o reprogramar, primero buscar_turnos_cliente.

IMPORTANTE sobre las fechas: no le pidas al cliente la fecha en formato yyyy-MM-dd. Entende 'el domingo que viene', 'pasado manana', 'el 11 de octubre' a partir de la fecha de hoy (esta en el system prompt). Si falta el año y el dia ya hay pasado este año, usa el año siguiente. Nunca digas 'hubiera un problema del lado del sistema' si una tool devuelve un error: explicale al cliente qué paso y ofrecele alternativas.`;
}

// ─── Enviar un mensaje de texto por la Cloud API de WhatsApp ───
async function responderWhatsApp(telefono: string, texto: string) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.error('FALTA WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID');
    return;
  }
  // Meta en Argentina: el webhook te entrega el "from" con el 9 (5493815512745),
  // pero la lista de destinatarios permitidos del caso de uso de prueba suele estar
  // sin el 9 (543815512745). Si la primera forma falla con 131030, probamos la otra.
  const alternativas = [telefono];
  if (telefono.startsWith('549')) alternativas.push('54' + telefono.slice(3));

  for (const to of alternativas) {
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
    if (r.ok) return;
    const textoRespuesta = await r.text();
    console.error(`WA error (to=${to}):`, textoRespuesta.slice(0, 300));
    // Si no es "no está autorizado", no tiene sentido reintentar con otro número.
    if (!textoRespuesta.includes('131030')) return;
  }
}
