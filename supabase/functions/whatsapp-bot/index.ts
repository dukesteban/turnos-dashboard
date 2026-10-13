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
    description:
      'Devuelve los horarios libres para un servicio y fecha. Si el cliente dijo a que hora queria, pasala en hora_preferida: la lista vuelve ordenada de esa hora hacia atras, y te dice si esa hora exacta se puede. Devuelve tambien el motivo si no se puede.',
    input_schema: {
      type: 'object',
      properties: {
        servicio_id: { type: 'number' },
        fecha: { type: 'string', description: 'YYYY-MM-DD' },
        hora_preferida: { type: 'string', description: 'HH:MM de lo que pidio el cliente, si dijo una' },
        empleado_id: { type: 'number', description: 'Solo si el cliente quiere un empleado concreto' },
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
        empleado_id: { type: 'number', description: 'Solo si el cliente quiere un empleado concreto. Si no, se asigna el primero libre.' },
      },
      required: ['servicio_id', 'fecha_hora'],
    },
  },
  {
    name: 'buscar_turnos_cliente',
    description: 'Busca los turnos del cliente por su numero de WhatsApp. Devuelve SOLO los de hoy en adelante y sin cancelados. Pon incluir_pasados=true solo si el cliente pidio explicitamente ver el historico.',
    input_schema: {
      type: 'object',
      properties: {
        incluir_pasados: { type: 'boolean', description: 'true solo si el cliente pidio el historico. Por omision no.' },
      },
      required: [],
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
    description: 'Cambia la fecha y/o la hora de un turno, y tambien puede cambiar el empleado que lo atiende. Usala cuando el cliente quiere otro horario o que lo atienda otra persona. Si el horario nuevo no esta libre, el empleado no labra ese dia, o el turno ya paso, devuelve error.',
    input_schema: {
      type: 'object',
      properties: {
        turno_id: { type: 'number' },
        nueva_fecha_hora: { type: 'string', description: 'ISO 8601, zona del negocio' },
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

const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

// ─── Nombre del negocio y proximos cierres, para la presentacion ───
// El cierre se lee de `dias_cerrados`: si el lavadero carga un feriado ahi, el bot lo
// dice solo, sin que nadie se lo recuerde en cada mensaje.
async function contextoNegocio(): Promise<{ nombre: string; cierres: string | null }> {
  const [{ data: conf }, { data: cerrados }] = await Promise.all([
    sb.from('configuracion').select('valor').eq('clave', 'nombre_negocio').maybeSingle(),
    sb.from('dias_cerrados').select('fecha, fecha_hasta, motivo').gte('fecha', new Date().toISOString().slice(0, 10)),
  ]);

  const nombre = conf?.valor || 'el lavadero';

  const proximos = (cerrados ?? [])
    .filter((c: any) => new Date(c.fecha + 'T00:00:00').getTime() <= Date.now() + 1000 * 60 * 60 * 24 * 30)
    .sort((a: any, b: any) => a.fecha.localeCompare(b.fecha));

  if (proximos.length === 0) return { nombre, cierres: null };

  const frases = proximos.slice(0, 2).map((c: any) => {
    const d = new Date(c.fecha + 'T00:00:00');
    const dia = d.getDate();
    const mes = MESES[d.getMonth()];
    const rango = c.fecha_hasta && c.fecha_hasta !== c.fecha
      ? ` al ${new Date(c.fecha_hasta + 'T00:00:00').getDate()} de ${mes}`
      : '';
    const motivo = c.motivo ? ` (${c.motivo.toLowerCase()})` : '';
    return `el ${dia} de ${mes}${rango} no trabajamos${motivo}`;
  });

  return {
    nombre,
    cierres: `recordale que ${frases.join(' y ')}`,
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
async function estadoDelDia(fecha: string, excluirTurnoId?: number) {
  const diaSemana = new Date(fecha + 'T00:00:00').getDay();
  const [{ data: empleados }, { data: turnos }, { data: ausencias }] = await Promise.all([
    sb.from('empleados').select('id, nombre, jornada').eq('activo', true).order('nombre'),
    sb.from('turnos')
      .select('id, hora_inicio, hora_fin, duracion_minutos, empleado_id')
      .eq('fecha', fecha)
      .neq('estado', 'cancelado'),
    sb
      .from('ausencias')
      .select('empleado_id, hora_inicio, hora_fin')
      .lte('desde', fecha)
      .gte('hasta', fecha),
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
      const { data: horarios } = await sb
        .from('horarios_atencion')
        .select('hora_inicio, hora_fin')
        .eq('dia_semana', diaSemana)
        .eq('activo', true)
        .order('hora_inicio', { ascending: true });
      if (!horarios || horarios.length === 0) return JSON.stringify({ ok: false, error: 'dia_cerrado' });

      // Un dia puede tener VARIOS bloques: el lavadero abre de 8 a 12 y de 14 a 20.
      // Antes se tomaba solo el primero y el bot daba el mediodía por cierre, saying
      // que a las 14 no se podía aunque la tarde estaba abierta.
      const bloques = (horarios as Array<{ hora_inicio: string; hora_fin: string }>).map((h) => ({
        desde: horaAMin(h.hora_inicio),
        hasta: horaAMin(h.hora_fin),
      }));

      // 3. la duracion la manda el servicio, no un slot fijo de 30 min
      const { data: serv } = await sb.from('servicios').select('id, nombre, duracion_minutos').eq('id', input.servicio_id).single();
      const duracion = serv?.duracion_minutos || 30;

      // 4. estado del dia, POR EMPLEADO. Un horario esta libre si hay AL MENOS UN
      //    empleado sin nada encima en esa franja: antes se miraba el negocio entero
      //    como un bloque, asi que un turno de uno tapaba los horarios de todos.
      const agenda = await estadoDelDia(fecha);

      // Si el cliente pidio un empleado concreto, la disponibilidad es la DE ESE, no la
      // de cualquiera. `alguien` decide a quien se le pregunta por disponibilidad.
      const pedido = input.empleado_id != null ? Number(input.empleado_id) : null;
      const nombrePedido = pedido != null
        ? (agenda.empleados.find((e: any) => e.id === pedido) ?? null)
        : null;
      const alguien = (a: number, b: number): boolean =>
        pedido != null ? agenda.libres(pedido, a, b) : agenda.algunoLibre(a, b);

      // 5. slots de 15 min que entren COMPLETOS dentro de ALGUN bloque del dia.
      //    El lavadero agenda en cualquier hora (hay turnos a las 08:15 y 08:45), asi
      //    que una grilla de 30 dejaba afuera horarios que el panel si acepta.
      const libres: number[] = [];
      for (const b of bloques) {
        let cur = b.desde;
        while (cur + duracion <= b.hasta) {
          if (alguien(cur, cur + duracion) && !libres.includes(cur)) libres.push(cur);
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
        motivo =
          pedido != null && nombrePedido
            ? `${nombrePedido.nombre} no esta libre a esa hora.`
            : 'A esa hora ya hay un turno.';
      }

      const ultimoSlot = libres.length ? libres.reduce((a, b) => (a > b ? a : b)) : null;

      return JSON.stringify({
        ok: true,
        libres: ordenada.map(minAHora),
        dia: fecha,
        inicio: sinSeg(horarios[0].hora_inicio),
        fin: sinSeg(horarios[horarios.length - 1].hora_fin),
        bloques: horarios.map((h: any) => `${sinSeg(h.hora_inicio)}-${sinSeg(h.hora_fin)}`),
        duracion_minutos: duracion,
        horario_pedido: pref != null ? minAHora(pref) : null,
        pedido_disponible: pref == null ? null : estaLibre,
        motivo_pedido: motivo,
        ultimo_horario: ultimoSlot != null ? minAHora(ultimoSlot) : null,
        nota: pref != null
          ? 'La lista viene ordenada de la hora que pidio el cliente hacia atras. Ofrecele solo las 3 primeras.'
          : 'Ordenadas por hora de apertura. Ofrecele solo las 3 primeras.',
        empleado_filtrado: nombrePedido ? nombrePedido.nombre : null,
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
      const hasta = desde + serv.duracion_minutos;
      const bloques = (horarios as Array<{ hora_inicio: string; hora_fin: string }>).map((h) => ({
        desde: horaAMin(h.hora_inicio),
        hasta: horaAMin(h.hora_fin),
      }));
      if (!bloques.some((b) => desde >= b.desde && hasta <= b.hasta)) {
        const texto = horarios
          .map((h: any) => `${sinSeg(h.hora_inicio)} a ${sinSeg(h.hora_fin)}`)
          .join(' y ');
        return err('fuera_de_horario', `Ese dia atendemos de ${texto}. El servicio dura ${serv.duracion_minutos} min.`);
      }

      // 5. que haya un empleado LIBRE en esa franja. Antes se comparaba solo la hora
      //    exacta de inicio, asi que un lavado de 45 min a las 10:00 no bloqueaba un
      //    turno de 60 min a las 10:30 (se pisaban), y el empleado salia siempre el
      //    primero del abecedario sin mirar si estaba ocupado.
      const agenda = await estadoDelDia(fecha);
      // Si el cliente dijo QUIEREN a alguien (el modelo paso empleado_id), es EXIGENTE:
      // si ese empleado esta ocupado hay que avisar, no asignarle otro en silencio.
      if (empleado_id != null && !agenda.libres(Number(empleado_id), desde, hasta)) {
        const { data: e } = await sb.from('empleados').select('nombre').eq('id', empleado_id).maybeSingle();
        return err('empleado_no_disponible', `${e?.nombre ?? 'Ese empleado'} no esta libre a esa hora.`);
      }
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

      // SOLO FUTUROS, por omision. El flag del modelo no es una garantia: si lo
      // olvida o lo manda en false, el bot le lista trece turnos de marzo y el
      // cliente cree que tiene una agenda llena. Para ver el historico hay que
      // pedirlo explicitamente con incluir_pasados.
      const incluirPasados = input.incluir_pasados === true;
      const hoy = new Date().toISOString().slice(0, 10);

      let consulta = sb
        .from('turnos')
        .select('id, fecha, hora, servicio_nombre, estado, empleado_id')
        .eq(clienteId ? 'cliente_id' : 'cliente_telefono', clienteId ?? telefono);

      // Un turno de hoy que ya paso no le sirve para nada: el cliente quiere lo que
      // tiene por delante, no lo que ya se le fue.
      if (!incluirPasados) {
        consulta = consulta.gte('fecha', hoy).neq('estado', 'cancelado');
      }

      const { data } = await consulta.order('fecha', { ascending: false }).limit(20);
      const resultado = data ?? [];
      return JSON.stringify({
        ok: true,
        turnos: resultado,
        total: resultado.length,
        nota: incluirPasados
          ? 'Incluye el historico completo.'
          : 'Solo turnos de hoy en adelante, sin cancelados.',
      });
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
      const { data: turno } = await sb.from('turnos').select('fecha, hora_inicio, hora_fin, estado, servicio_id, duracion_minutos, servicio_nombre').eq('id', turno_id).single();
      if (!turno) return err('turno_no_encontrado');
      if (turno.estado === 'cancelado') return err('turno_cancelado');

      // Un turno YA pasado no se reprograma: no da "falta menos de 12 horas" sino
      // "ese turno ya fue", que es lo unico cierto y lo que el cliente entiende.
      const hoy = new Date().toISOString().slice(0, 10);
      if (turno.fecha < hoy) {
        return err('turno_ya_pasado', `El turno del ${turno.fecha} ya fue. Para algo de hoy en adelante, mejor agendá uno nuevo.`);
      }

      const minsFaltan = (new Date(turno.fecha + 'T' + turno.hora_inicio).getTime() - Date.now()) / 60000;
      const minsMin = (await horasMinCancelar()) * 60;
      if (minsFaltan < minsMin) return err('fuera_de_plazo', `Se reprograma hasta ${minsMin / 60} hs antes.`);

      const dt = new Date(nueva_fecha_hora);
      if (isNaN(dt.getTime())) return err('fecha_invalida');
      if (dt.getTime() < Date.now()) return err('fuera_de_horario', 'La fecha ya paso.');

      const nuevaFecha = nueva_fecha_hora.split('T')[0];
      const nuevaHora = nueva_fecha_hora.split('T')[1].slice(0, 5);

      // Mismas validaciones que crear_turno: si el turno nuevo no se puede agendar,
      // reprogramar tampoco.
      const { data: cerradosRe } = await sb.from('dias_cerrados').select('fecha, fecha_hasta');
      if (diaCerrado(cerradosRe ?? [], nuevaFecha)) return err('fuera_de_horario', 'Ese dia el negocio no atiende.');

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

      return JSON.stringify({
        ok: true,
        turno_id,
        fecha: nuevaFecha,
        hora: nuevaHora,
        hora_fin: minAHora(hasta),
        servicio: turno.servicio_nombre,
        empleado_id: empleadoFinal,
        empleado_nombre: quienRe?.nombre ?? null,
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

  const system = `Sos el asistente por WhatsApp de ${negocio.nombre}. Español rioplatense, corto y amable. Escribí SIEMPRE en español: nunca una palabra en inglés (ni "let me", ni "one moment"), ni aunque sea un comentario mientras trabajás.

Fechas: hoy es ${hoyIso} (${DIAS_SEMANA[hoy.getDay()]}). Esta es la tabla de los próximos días, con el nombre de cada uno: ${tablaDeDias()}. Cuando el cliente diga un día ("el lunes", "el domingo que viene", "mañana", "el 20"), buscá la fecha en esta tabla y pasala así a las tools. NO la calcules vos: antes te equivocabas el día de la semana y el cliente recibía un horario del día equivocado. Tool de verdad antes de afirmar: nunca confirmás turno sin que crear_turno te devuelva ok, y nunca decís que un horario está libre sin antes llamar consultar_horarios_libres. Si una tool devuelve error, le explicás al cliente qué pasó y ofrecés otro camino.

Presentacion: ${esPrimerMensaje ? `este es el PRIMER mensaje de la conversacion, asi que abri presentandote como el bot de "${negocio.nombre}"${negocio.cierres ? ` y avisale que ${negocio.cierres}` : ''}. No lo hagas en los mensajes siguientes.` : 'ya te presentaste antes, no te vuelvas a presentar.'}

Reglas de UX: todos los bloques de texto que escribas ANTES de una tool se leen al cliente (se juntan en un solo mensaje), asi que no te repitas: escribí una sola vez que vas a chequear y seguí. Y nunca anuncies algo que todavia no verificaste: si vas a llamar una tool para reservar o consultar, no arranques diciendo "dale, te lo reservo" ni "dale, chequeo" con la fecha y la hora detailadas; la frase previa tiene que ser generica (un "un momento", o nada) y el detalle va DESPUÉS del resultado de la tool. Si la tool falla, esa frase previa ya le dijo al cliente que estaba reservado. Cuando el cliente diga una hora concreta, pasala siempre en hora_preferida de consultar_horarios_libres. La lista te vuelve ordenada de esa hora hacia atras: ofrecele las 2 o 3 primeras, que son las mas parecidas a lo que pidio. Si vuelve pedido_disponible=false, decile el motivo_pedido tal cual (dice si esta tomado o si el servicio no entra antes del cierre) y ofrecele las alternativas de la lista; no te inventes otro motivo. Si el cliente no dijo hora, ofrecé 3 horarios de la lista, tampoco todos. Si el cliente pide que lo atienda otra persona o en otro horario, usá reprogramar_turno pasándole empleado_id: sin ese campo el turno se reprograma pero se queda con el empleado anterior, y vos le dirás al cliente que lo atiende alguien que no lo atiende. Anunciá siempre el empleado_nombre que TE DEVUELVE la tool, nunca el que esperabas: si la tool te devuelve otro, ese es el que atiende. Si el cliente quiere un empleado concreto para un turno NUEVO, llamá buscar_empleados y pasale su id en empleado_id de consultar_horarios_libres y de crear_turno; nunca le asignes a otro en silencio. Nunca digas que un día está cerrado sin antes llamar consultar_horarios_libres o haber leído dias_cerrados. Al saludar, si buscar_cliente te dio un nombre, usalo: el cliente ya está registrado y no hay que pedirle el nombre. NUNCA menciones los turnos que tiene el cliente salvo que los hayas leído recién con buscar_turnos_cliente en ESTE mensaje: no los recuerdes de mensajes anteriores, pueden haber sido cancelados o borrados. Y NUNCA respondas sobre disponibilidad, sobre quien atiende, o sobre si un cambio se pudo hacer, sin llamar a la tool en ESTE mensaje: lo que contestaste hace dos mensajes puede haber cambiado (otro cliente agendó, el empleado se inactivó, el turno se movió). Si el cliente repite una pregunta, volvé a llamar a la tool, no contestés de memoria. Si el cliente eligió una hora que no estaba entre las que ofreciste, no digas que la reservaste sin llamar crear_turno.

${spec}`;

  const tools = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  // Primer turno: Claude ve el historial y decide si llamar una tool o responder
  let response = await llamarClaude(system, historial, tools);
  // Claude puede escribir texto ANTES de pedir una tool ("Dale, te lo reservo..."). Ese
  // texto se descartaba al quedarnos solo con el último bloque, y con él se perdía la
  // presentación. Se juntan todos, pero SIN repetir: el modelo sigue la instrucción de
  // "no te repitas" en algunos casos y en otros dice la misma frase textual antes y
  // después de la tool, que es lo que el cliente ve como mensaje doble.
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

  for (const b of response.content ?? []) {
    if (b.type === 'text' && b.text.trim()) partes.push(b.text.trim());
  }

  return unirRespuesta(partes);
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
function unirRespuesta(partes: string[]): string {
  const utiles = partes.filter((p) => p.trim());
  // Con una o dos partes no hay nada que quitar.
  if (utiles.length <= 2) return sinRepetir(utiles);
  return sinRepetir([utiles[0], utiles[utiles.length - 1]]);
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
    // Si algo falla, al menos que el cliente tenga por donde pedir ayuda en vez de
    // quedarse mirando un "probá en unos minutos" sin salida.
    respuesta = await mensajeDeFalla();
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
1. Cuando el cliente saluda, o antes de agendar, llama buscar_cliente. Si devuelve un nombre, saludalo por su nombre y NO le pidas el nombre otra vez: crear_turno lo resuelve solo. Si no devuelve nada, es un cliente nuevo y ahi si se lo pides.
2. Si el cliente viene por un turno nuevo, pedile el servicio.
3. Cuando elija servicio, mostra los horarios libres con consultar_horarios_libres.
4. Si elige horario, crealo con crear_turno.
5. Si quiere cancelar o reprogramar, primero buscar_turnos_cliente. Si quiere cambiar la fecha o la hora de un turno que ya tiene, se reprograma con reprogramar_turno (primero le decis a que turno se refiere, con buscar_turnos_cliente, y le mostras el horario nuevo antes de llamar a la tool). Si el turno que quiere tocar ya paso, no se reprograma: se agenda uno nuevo.

IMPORTANTE sobre las fechas: no le pidas al cliente la fecha en formato yyyy-MM-dd. Entende 'el domingo que viene', 'pasado manana', 'el 11 de octubre' a partir de la fecha de hoy (esta en el system prompt). Si falta el año y el dia ya hay pasado este año, usa el año siguiente. Nunca digas 'hubiera un problema del lado del sistema' si una tool devuelve un error: explicale al cliente qué paso y ofrecele alternativas.`;
}

// ─── Enviar un mensaje de texto por la Cloud API de WhatsApp ───
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
