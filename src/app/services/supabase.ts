import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';
import { jornadaCubre, turnoTocadoPorAusencia, textoAusencia } from '../utils/fechas';

@Injectable({
  providedIn: 'root'
})
export class SupabaseService {
  private supabase: SupabaseClient;

  constructor() {
    this.supabase = createClient(
      environment.supabaseUrl,
      environment.supabaseKey
    );
  }

  suscribirTurnos(callback: () => void) {
    return this.supabase
      .channel('turnos-cambios')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'turnos' },
        () => callback()
      )
      .subscribe();
  }

  suscribirHorarios(callback: () => void) {
    return this.supabase
      .channel('horarios-cambios')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'horarios_atencion' },
        () => callback()
      )
      .subscribe();
  }
  
  // USUARIOS
  async verificarUsuario(usuario: string, passwordHash: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('usuarios')
      .select('id')
      .eq('usuario', usuario)
      .eq('password_hash', passwordHash)
      .maybeSingle();
    if (error) return false;
    return !!data;
  }

  async cambiarPassword(usuario: string, nuevoHash: string): Promise<void> {
    const { error } = await this.supabase
      .from('usuarios')
      .update({ password_hash: nuevoHash })
      .eq('usuario', usuario);
    if (error) throw error;
  }

  // TURNOS
  async getTurnos() {
    const { data, error } = await this.supabase
      .from('turnos')
      .select('*')
      .order('fecha', { ascending: false })
      .order('hora', { ascending: false });
    if (error) throw error;
    return data;
  }

  async getTurnosHoy() {
    const hoy = new Date().toLocaleDateString('en-CA');
    const { data, error } = await this.supabase
      .from('turnos')
      .select('*')
      .eq('fecha', hoy)
      .order('hora', { ascending: false });
    if (error) throw error;
    return data;
  }

  async updateEstadoTurno(id: number, estado: string) {
    const { error } = await this.supabase
      .from('turnos')
      .update({ estado })
      .eq('id', id);
    if (error) throw error;
  }

  async getEstadisticas() {
    const { data, error } = await this.supabase
      .from('turnos')
      .select('precio, estado, fecha');
    if (error) throw error;
    return data;
  }

  async editarTurno(id: number, datos: any) {
    const horaInicio = datos.hora.length === 5 ? datos.hora + ':00' : datos.hora;
    const horaFin = datos.horaFin.length === 5 ? datos.horaFin + ':00' : datos.horaFin;
    const update: any = {
      fecha: datos.fecha,
      hora: horaInicio,
      hora_inicio: horaInicio,
      hora_fin: horaFin,
      servicio_id: datos.servicio_id,
      servicio_nombre: datos.servicio_nombre,
      precio: datos.precio,
      duracion_minutos: datos.duracion_minutos
    };
    // El empleado es OBLIGATORIO: es lo que define la columna de la agenda y
    // quien cobra la comisión. No se toca puesto_id (ver migracion 011).
    if ('empleado_id' in datos) update.empleado_id = datos.empleado_id;

    const { error } = await this.supabase
      .from('turnos')
      .update(update)
      .eq('id', id);
    if (error) throw error;
  }

  // ── PUESTOS: la tabla ya NO EXISTE (migracion 011) ─────────
  //
  // La agenda usa una columna por EMPLEADO. Estas funciones quedaron sin uso y
  // su tabla fue borrada: si alguna vez hacen falta, no alcanza con descomentarlas.
  //
  //   async asignarPuestoATurno(turnoId, puestoId, empleadoId) {...}
  //   async puestoDeEmpleado(empleadoId) {...}

  /** El empleado es obligatorio al agendar. Corta acá si viene null. */
  async exigeEmpleado(empleadoId: number | null | undefined): Promise<number> {
    if (empleadoId == null) throw new Error('El turno tiene que tener un empleado asignado.');
    return empleadoId;
  }

  async getTurnosCliente(clienteId: number) {
    const { data, error } = await this.supabase
      .from('turnos')
      .select('*')
      .eq('cliente_id', clienteId)
      .order('fecha', { ascending: false });
    if (error) throw error;
    return data;
  }

  async crearTurnoManual(turno: any) {
    const { data, error } = await this.supabase
      .from('turnos')
      .insert(turno)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async marcarAtendido(id: number, datos: {
    servicio_nombre_final: string,
    servicio_id_final?: number | null,
    precio_final: number,
    metodo_pago: string,
    observaciones: string,
    empleado_id?: number | null
  }) {
    const update: any = {
      estado: 'atendido',
      ...datos
    };
    // Nunca pisar el empleado con null: si no viene, se conserva el que ya tenia.
    // (si se escribiera null, el turno perdia la comision y quedaba sin columna)
    if (datos.empleado_id == null) {
      delete update.empleado_id;
    }

    const { error } = await this.supabase
      .from('turnos')
      .update(update)
      .eq('id', id);
    if (error) throw error;
  }

  async volverAPendiente(id: number) {
    // Se borra solo lo de la atencion. NO se toca empleado_id / puesto_id:
    // la asignacion es de la reserva, no del atendimento, y antes se perdia al
    // volver a pendiente (dejando puesto_id puesto y empleado_id en null).
    const { error } = await this.supabase
      .from('turnos')
      .update({
        estado: 'pendiente',
        metodo_pago: null,
        precio_final: null,
        observaciones: null,
        servicio_nombre_final: null,
        servicio_id_final: null
      })
      .eq('id', id);
    if (error) throw error;
  }

  // CONFIGURACION
  async getConfiguracion() {
    const { data, error } = await this.supabase
      .from('configuracion')
      .select('*');
    if (error) throw error;
    return data;
  }

  async updateConfiguracion(clave: string, valor: string) {
    const { error } = await this.supabase
      .from('configuracion')
      .update({ valor })
      .eq('clave', clave);
    if (error) throw error;
  }

  async upsertConfiguracion(clave: string, valor: string) {
    const { error } = await this.supabase
      .from('configuracion')
      .upsert({ clave, valor }, { onConflict: 'clave' });
    if (error) throw error;
  }

  // ── PUESTOS: la tabla ya NO EXISTE (migracion 011) ─────────
  //
  // La agenda usa una columna por EMPLEADO. La tabla `puestos` fue BORRADA de la
  // base el 2026-10-03, asi que estas consultas fallarian si se reactivaran.
  // El historial de "en que box se lavo" sigue en `turnos.puesto_id` (sin FK).
  //
  //   async getPuestos() {
  //     const { data, error } = await this.supabase
  //       .from('puestos')
  //       .select('*, empleados(id, nombre, activo, comision_porcentaje, jornada)')
  //       .order('orden', { ascending: true })
  //       .order('id', { ascending: true });
  //     ...
  //   }
  //
  // Y el CRUD (crearPuesto / actualizarPuesto / eliminarPuesto) mas abajo.

  /**
   * Un empleado es agendable si:
   *   - esta activo
   *   - la JORNADA cubre ese dia/hora        (patron recurrente)
   *   - no tiene una AUSENCIA que lo tape    (excepcion con fecha)
   *
   * Antes esta funcion recibia un PUESTO y validaba "puesto activo + tiene
   * empleado + el empleado puede". Con una columna por empleado desaparece la
   * parte del puesto y queda solo la disponibilidad de la persona.
   *
   * Devuelve el motivo del rechazo para poder mostrarlo en la UI
   * ("No trabaja ese día", "Sale a las 13:00", "Vacaciones al 15/12").
   */
  empleadoEsAgendable(
    empleado: any,
    fecha?: string,
    horaInicio?: string,
    duracionMin?: number,
    ausencias: any[] = []
  ): boolean | { agendable: boolean; motivo?: string } {
    let motivo: string | undefined;
    if (!empleado) motivo = 'Sin empleado';
    else if (empleado.activo === false) motivo = 'Empleado inactivo';
    else if (fecha) {
      const dur = duracionMin || 45;
      const j = jornadaCubre(empleado.jornada, fecha, horaInicio || '00:00', dur);
      if (!j.ok) motivo = j.motivo;
      else {
        const a = turnoTocadoPorAusencia(ausencias, fecha, horaInicio || '00:00', dur);
        if (a) motivo = textoAusencia(a);
      }
    }
    return fecha ? { agendable: !motivo, motivo } : !motivo;
  }

  /** Mismo chequeo pero siempre devuelve solo el motivo (o null si puede). */
  motivoDeNoAtender(
    empleado: any, fecha: string, horaInicio: string, duracionMin: number, ausencias: any[] = []
  ): string | null {
    const r = this.empleadoEsAgendable(empleado, fecha, horaInicio, duracionMin, ausencias) as any;
    return r.agendable ? null : (r.motivo || 'No disponible');
  }

  /**
   * Un empleado puntual puede atender este turno?
   * Capa 1 (jornada semanal) + capa 2 (ausencias). Es el chequeo que hay que
   * hacer cuando el usuario elige a mano, porque `puestoEstaOcupado` solo mira
   * los turnos y nowho puede trabajar.
   */
  async empleadoPuedeAtender(
    empleadoId: number, fecha: string, horaInicio: string,
    duracionMin: number, ausencias?: any[]
  ): Promise<{ ok: boolean; motivo?: string }> {
    const aus = ausencias ?? (await this.getAusencias(empleadoId));
    const { data, error } = await this.supabase
      .from('empleados')
      .select('id, nombre, activo, jornada')
      .eq('id', empleadoId)
      .single();
    if (error || !data) return { ok: false, motivo: 'Empleado inexistente' };
    if (data.activo === false) return { ok: false, motivo: 'Empleado inactivo' };

    const j = jornadaCubre(data.jornada, fecha, horaInicio, duracionMin);
    if (!j.ok) return j;

    const a = turnoTocadoPorAusencia(aus, fecha, horaInicio, duracionMin);
    return a ? { ok: false, motivo: textoAusencia(a) } : { ok: true };
  }

  // ── AUSENCIAS ────────────────────────────────────────────────

  async getAusencias(empleadoIds?: number | number[], desde?: string, hasta?: string) {
    let q = this.supabase.from('ausencias').select('*').order('desde', { ascending: true });
    const ids = Array.isArray(empleadoIds) ? empleadoIds : empleadoIds ? [empleadoIds] : null;
    if (ids?.length) q = q.in('empleado_id', ids);
    if (desde) q = q.gte('desde', desde);
    if (hasta) q = q.lte('hasta', hasta);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async crearAusencia(a: Partial<{
    empleado_id: number; desde: string; hasta: string | null;
    hora_inicio: string | null; hora_fin: string | null; tipo: string; motivo: string | null;
  }>) {
    const { data, error } = await this.supabase
      .from('ausencias')
      .insert({ ...a, tipo: a.tipo || 'ausencia' })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async actualizarAusencia(id: number, cambios: any) {
    const { error } = await this.supabase.from('ausencias').update(cambios).eq('id', id);
    if (error) throw error;
  }

  async eliminarAusencia(id: number) {
    const { error } = await this.supabase.from('ausencias').delete().eq('id', id);
    if (error) throw error;
  }

  /** Turnos pendientes de un empleado en un rango de fechas (para avisar al guardar una ausencia). */
  async getTurnosPendientesDe(empleadoId: number, desde: string, hasta: string) {
    const { data, error } = await this.supabase
      .from('turnos')
      .select('id, fecha, hora_inicio, hora, duracion_minutos, cliente_nombre, estado')
      .eq('empleado_id', empleadoId)
      .eq('estado', 'pendiente')
      .gte('fecha', desde)
      .lte('fecha', hasta);
    if (error) throw error;
    return data || [];
  }

  // ── PUESTOS: CRUD retirado, tabla BORRADA (migracion 011) ──
  //
  // Ninguno se llama desde la app y la tabla ya no existe. Si volvieran a hacer
  // falta, revisar PRIMERO por que se decidio que la columna de la agenda es el
  // empleado: el problema de origen era que un puesto tiene un unico empleado
  // para toda la semana, y no se puede cubrir "solo el jueves".
  //
  //   async crearPuesto(puesto)         -> INSERT en 'puestos'
  //   async actualizarPuesto(id, c)     -> UPDATE 'puestos'
  //   async desactivarPuesto(id)        -> UPDATE 'puestos' SET activo=false
  //   async reordenarPuestos(ids)       -> UPDATE 'puestos' SET orden = i
  //   async eliminarPuesto(id)          -> DELETE 'puestos'
  /**
   * Nucleo de disponibilidad. Responde la pregunta:
   * "para esta fecha/hora, que empleados quedan libres y pueden atender?"
   * Es la funcion que consumira el agente de WhatsApp.
   */
  async getEmpleadosDisponibles(
    fecha: string, horaInicio: string, duracionMin: number, ausencias: any[] = []
  ) {
    const [h, m] = (horaInicio.length === 5 ? horaInicio : horaInicio.slice(0, 5)).split(':');
    const total = parseInt(h, 10) * 60 + parseInt(m, 10) + (duracionMin || 45);
    const horaFin = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

    const [{ data: turnosDia }, empleados] = await Promise.all([
      this.supabase
        .from('turnos')
        .select('empleado_id, hora_inicio, hora_fin')
        .eq('fecha', fecha)
        .neq('estado', 'cancelado'),
      this.getEmpleados(),
    ]);

    const ini = horaInicio.length === 5 ? horaInicio + ':00' : horaInicio;
    const solapados = (turnosDia || []).filter((t: any) => {
      const ti = t.hora_inicio || '00:00:00';
      const tf = t.hora_fin || ti;
      return ti < horaFin && tf > ini;
    });

    // El doble booking ahora es por EMPLEADO. Antes era por puesto, pero como
    // puesto<->empleado era 1:1 la condicion era equivalente: misma columna.
    const ocupados = new Set(solapados.map((t: any) => t.empleado_id).filter(Boolean));

    return empleados
      .filter((e: any) => e.activo)
      .map((e: any) => {
        const { agendable, motivo } = this.empleadoEsAgendable(
          e, fecha, horaInicio, duracionMin, ausencias
        ) as { agendable: boolean; motivo?: string };
        const libre = !ocupados.has(e.id);
        return {
          empleado_id: e.id,
          nombre: e.nombre,
          jornada: e.jornada || null,
          comision_porcentaje: e.comision_porcentaje,
          // Que pueda trabajar o no, y el motivo si no puede.
          puede_atender: agendable,
          motivo_bloqueo: agendable ? null : (motivo || 'No disponible'),
          // Agenda solo si ademas esta LIBRE en ese horario.
          agendable: agendable && libre,
          libre,
          ocupado_por: libre
            ? null
            : solapados.find((t: any) => t.empleado_id === e.id) || null,
        };
      });
  }

  /** Primer empleado agendable y libre. Base del autoscaneo del agente de WhatsApp. */
  async getPrimerEmpleadoLibre(fecha: string, horaInicio: string, duracionMin: number, ausencias: any[] = []) {
    const disponibles = await this.getEmpleadosDisponibles(fecha, horaInicio, duracionMin, ausencias);
    return disponibles.find((e: any) => e.agendable) || null;
  }

  /** Confirma que el empleado no tenga otro turno en ese rango (doble booking). */
  async empleadoEstaOcupado(empleadoId: number, fecha: string, horaInicio: string, duracionMin: number, excludeTurnoId = 0): Promise<boolean> {
    const [h, m] = horaInicio.split(':');
    const total = parseInt(h, 10) * 60 + parseInt(m, 10) + duracionMin;
    const horaFin = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    const ini = horaInicio.length === 5 ? horaInicio + ':00' : horaInicio;

    const { data, error } = await this.supabase
      .from('turnos')
      .select('id, hora_inicio, hora_fin')
      .eq('fecha', fecha)
      .eq('empleado_id', empleadoId)
      .neq('estado', 'cancelado')
      .neq('id', excludeTurnoId)
      .lt('hora_inicio', horaFin)
      .gt('hora_fin', ini);
    if (error) throw error;
    return (data?.length || 0) > 0;
  }

  // METODOS DE PAGOS
  async getMetodosPago() {
    const { data, error } = await this.supabase
      .from('metodos_pago')
      .select('*')
      .eq('activo', true)
      .order('orden');
    if (error) throw error;
    return data;
  }

  async createMetodoPago(nombre: string, emoji: string) {
    const { data, error } = await this.supabase
      .from('metodos_pago')
      .insert({ nombre, emoji, orden: 99 })
      .select().single();
    if (error) throw error;
    return data;
  }

  async updateMetodoPago(id: number, datos: any) {
    const { error } = await this.supabase
      .from('metodos_pago')
      .update(datos)
      .eq('id', id);
    if (error) throw error;
  }

  async deleteMetodoPago(id: number) {
    const { error } = await this.supabase
      .from('metodos_pago')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }

  // HORARIOS
  async getHorarios() {
    const { data, error } = await this.supabase
      .from('horarios_atencion')
      .select('*')
      .order('dia_semana', { ascending: true })
      .order('hora_inicio', { ascending: true });
    if (error) throw error;
    return data;
  }

  async updateHorario(id: number, horario: any) {
    const { error } = await this.supabase
      .from('horarios_atencion')
      .update(horario)
      .eq('id', id);
    if (error) throw error;
  }

  async createHorario(horario: any) {
    const { data, error } = await this.supabase
      .from('horarios_atencion')
      .insert(horario)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async deleteHorario(id: number) {
    const { error } = await this.supabase
      .from('horarios_atencion')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }

  //DÍAS CERRADOS
  async getDiasCerrados() {
    const { data, error } = await this.supabase
      .from('dias_cerrados')
      .select('*')
      .order('fecha', { ascending: true });
    if (error) throw error;
    return data;
  }

  async createDiasCerrados(fecha: string, fechaHasta: string | null, motivo: string) {
    const { data, error } = await this.supabase
      .from('dias_cerrados')
      .insert({ fecha, fecha_hasta: fechaHasta || null, motivo })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async updateDiasCerrados(id: number, fecha: string, fechaHasta: string | null, motivo: string) {
    const { error } = await this.supabase
      .from('dias_cerrados')
      .update({ fecha, fecha_hasta: fechaHasta || null, motivo })
      .eq('id', id);
    if (error) throw error;
  }

  async deleteDiasCerrados(id: number) {
    const { error } = await this.supabase
      .from('dias_cerrados')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }

  // SERVICIOS
  async getServicios() {
    const { data, error } = await this.supabase
      .from('servicios')
      .select('*')
      .order('precio', { ascending: true });
    if (error) throw error;
    return data;
  }

  async createServicio(servicio: any) {
    const { data, error } = await this.supabase
      .from('servicios')
      .insert(servicio)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async updateServicio(id: number, servicio: any) {
    const { error } = await this.supabase
      .from('servicios')
      .update(servicio)
      .eq('id', id);
    if (error) throw error;
  }

  async deleteServicio(id: number) {
    const { error } = await this.supabase
      .from('servicios')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }

  // CLIENTES
  async getClientes() {
    const { data, error } = await this.supabase
      .from('clientes')
      .select('*, telefonos(*)')
      .order('nombre', { ascending: true })
      .order('principal', { ascending: false, referencedTable: 'telefonos' });
    if (error) throw error;
    return data;
  }

  async updateCliente(id: number, nombre: string) {
    const { error } = await this.supabase
      .from('clientes')
      .update({ nombre })
      .eq('id', id);
    if (error) throw error;

    // Actualizar nombre en todos los turnos del cliente
    const { error: error2 } = await this.supabase
      .from('turnos')
      .update({ cliente_nombre: nombre })
      .eq('cliente_id', id);
    if (error2) throw error2;
  }

  async fusionarClientes(principalId: number, duplicadoId: number) {
    // 1. Obtener teléfonos del principal para evitar duplicados
    const { data: telsPrincipal } = await this.supabase
      .from('telefonos')
      .select('telefono')
      .eq('cliente_id', principalId);

    const numerosExistentes = new Set(telsPrincipal?.map((t: any) => t.telefono) || []);

    // 2. Obtener teléfonos del duplicado
    const { data: telsDuplicado } = await this.supabase
      .from('telefonos')
      .select('*')
      .eq('cliente_id', duplicadoId);

    // 3. Mover solo los teléfonos que no existen ya en el principal
    for (const tel of telsDuplicado || []) {
      if (!numerosExistentes.has(tel.telefono)) {
        await this.supabase
          .from('telefonos')
          .update({ cliente_id: principalId, principal: false })
          .eq('id', tel.id);
      }
    }

    // 3b. Eliminar los teléfonos duplicados que quedaron en el duplicado
    await this.supabase
      .from('telefonos')
      .delete()
      .eq('cliente_id', duplicadoId);

    // 4. Mover todos los turnos del duplicado al principal
    const { data: clientePrincipal } = await this.supabase
      .from('clientes')
      .select('nombre')
      .eq('id', principalId)
      .single();

    const { data: telPrincipal } = await this.supabase
      .from('telefonos')
      .select('telefono')
      .eq('cliente_id', principalId)
      .eq('principal', true)
      .single();

    await this.supabase
      .from('turnos')
      .update({
        cliente_id: principalId,
        cliente_nombre: clientePrincipal?.nombre,
        cliente_telefono: telPrincipal?.telefono || null
      })
      .eq('cliente_id', duplicadoId);

    // 5. Eliminar el duplicado
    const { error } = await this.supabase
      .from('clientes')
      .delete()
      .eq('id', duplicadoId);
    if (error) throw error;
  }

  async agregarTelefono(clienteId: number, telefono: string) {
    const { data, error } = await this.supabase
      .from('telefonos')
      .insert({ cliente_id: clienteId, telefono, principal: false })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  /**
   * Mapa cliente_id -> teléfono ACTUAL (principal primero).
   *
   * `turnos.cliente_telefono` es un snapshot desnormalizado: si al cliente le
   * cargan el teléfono después de tomar el turno, el snapshot queda viejo y la
   * UI decía "Sin teléfono" / mandaba WhatsApp al número anterior.
   * Con este mapa la pantalla siempre lee la fuente de verdad.
   */
  async getTelefonosPorCliente(): Promise<Record<number, string>> {
    const { data, error } = await this.supabase
      .from('telefonos')
      .select('cliente_id, telefono, principal');
    if (error) throw error;

    const mapa: Record<number, string> = {};
    for (const t of (data || []) as any[]) {
      if (!t?.cliente_id || !t?.telefono) continue;   // ignora '' y null
      if (!mapa[t.cliente_id] || t.principal) mapa[t.cliente_id] = t.telefono;
    }
    return mapa;
  }

  /** Propaga el teléfono a los turnos. Queda como respaldo del snapshot. */
  async actualizarTelefonoEnTurnos(clienteId: number, telefono: string) {
    const { error } = await this.supabase
      .from('turnos')
      .update({ cliente_telefono: telefono || null })
      .eq('cliente_id', clienteId);
    if (error) throw error;
  }

  async eliminarTelefono(id: number) {
    const { error } = await this.supabase
      .from('telefonos')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }

  async marcarTelefonoPrincipal(clienteId: number, telId: number) {
    // Desmarcar todos
    await this.supabase.from('telefonos')
      .update({ principal: false })
      .eq('cliente_id', clienteId);
    // Marcar el nuevo
    const { error } = await this.supabase.from('telefonos')
      .update({ principal: true })
      .eq('id', telId);
    if (error) throw error;
  }

  async editarTelefono(id: number, telefono: string) {
    const { error } = await this.supabase.from('telefonos')
      .update({ telefono })
      .eq('id', id);
    if (error) throw error;
  }

  async crearCliente(nombre: string) {
    const { data, error } = await this.supabase
      .from('clientes')
      .insert({ nombre })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async verificarNombreDuplicado(nombre: string, excludeId?: number): Promise<boolean> {
    let query = this.supabase
      .from('clientes')
      .select('id')
      .ilike('nombre', nombre);
    if (excludeId) query = query.neq('id', excludeId);
    const { data, error } = await query;
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  normalizarNombre(nombre: string): string {
    return nombre.trim().toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
  }

  // GANANCIAS
  async getGanancias(desde: string, hasta: string) {
    const { data, error } = await this.supabase
      .from('turnos')
      .select('*')
      .eq('estado', 'atendido')
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha', { ascending: true });
    if (error) throw error;
    return data;
  }

  // EMPLEADOS

  /**
   * `soloActivos` existe porque la pantalla de Empleados quiere MOSTRAR los
   * inactivos (con su badge "Inactivo"), pero todos los selectores de turnos,
   * la agenda y las comisiones tienen que seguir ofreciendo solo gente activa.
   *
   * Si se saca el `.eq('activo', true)` sin el parametro, los selectores
   * empiezan a ofrecer empleados dados de baja.
   */
  async getEmpleados(soloActivos = true) {
    let q = this.supabase
      .from('empleados')
      .select('*')
      .order('nombre', { ascending: true });
    if (soloActivos) q = q.eq('activo', true);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  /** Todos, inactivos incluidos. Solo para la lista de la pantalla de Empleados. */
  async getTodosEmpleados() {
    return this.getEmpleados(false);
  }

  async crearEmpleado(empleado: any) {
    const { data, error } = await this.supabase
      .from('empleados')
      .insert({ ...empleado, activo: true })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async updateEmpleado(id: number, datos: any) {
    const { error } = await this.supabase
      .from('empleados')
      .update(datos)
      .eq('id', id);
    if (error) throw error;
  }

  async deleteEmpleado(id: number) {
    const { error } = await this.supabase
      .from('empleados')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }

  async calcularComisiones(empleadoId: number, desde: string, hasta: string) {
    const { data, error } = await this.supabase
      .from('turnos')
      .select('*')
      .eq('estado', 'atendido')
      .eq('empleado_id', empleadoId)
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha', { ascending: true });
    if (error) throw error;

    // Obtener el empleado para calcular la comisión general
    const { data: empleado } = await this.supabase
      .from('empleados')
      .select('comision_porcentaje')
      .eq('id', empleadoId)
      .single();

    const porcentajeGeneral = empleado?.comision_porcentaje || 0;

    // Obtener comisiones específicas por servicio
    const { data: comisionesServicio } = await this.supabase
      .from('comisiones_empleado')
      .select('*')
      .eq('empleado_id', empleadoId);

    const comisionesMap = new Map();
    (comisionesServicio || []).forEach((c: any) => {
      comisionesMap.set(c.servicio_id, c.porcentaje);
    });

    return (data || []).map((turno: any) => {
      // El servicio que se cobró puede diferir del reservado (ej: pidió completo,
      // se hizo simple). La comision se calcula sobre el REALMENTE realizado.
      const servicioRealId = turno.servicio_id_final ?? turno.servicio_id;
      const porcentaje = comisionesMap.get(servicioRealId) ?? porcentajeGeneral;
      const precioReal = Number(turno.precio_final ?? turno.precio) || 0;
      return {
        ...turno,
        // La plantilla muestra servicio_nombre: hay que overwrite con el realizado
        servicio_nombre: turno.servicio_nombre_final || turno.servicio_nombre,
        precio_final: precioReal,
        comision: (precioReal * porcentaje) / 100
      };
    });
  }

  // COMISIONES POR SERVICIO
  async getComisionesEmpleado(empleadoIds: number | number[]) {
    const ids = Array.isArray(empleadoIds) ? empleadoIds : [empleadoIds];
    const { data, error } = await this.supabase
      .from('comisiones_empleado')
      .select('*')
      .in('empleado_id', ids);
    if (error) throw error;
    return data || [];
  }

  async upsertComisionEmpleado(empleadoId: number, servicioId: number, porcentaje: number) {
    const { error } = await this.supabase
      .from('comisiones_empleado')
      .upsert(
        { empleado_id: empleadoId, servicio_id: servicioId, porcentaje },
        { onConflict: 'empleado_id,servicio_id' }
      );
    if (error) throw error;
  }

  async deleteComisionEmpleado(empleadoId: number, servicioId: number) {
    const { error } = await this.supabase
      .from('comisiones_empleado')
      .delete()
      .eq('empleado_id', empleadoId)
      .eq('servicio_id', servicioId);
    if (error) throw error;
  }

  // ── CAJA: PAGOS A EMPLEADOS ────────────────────────────────
  //
  // Esto es el PAGO REAL, no el cálculo. El "sugerido" sale de
  // `calcularComisiones()`, que aplica el porcentaje sobre los turnos atendidos.
  // La caja muestra los dos y la diferencia, porque casi nunca coinciden: se
  // pagan quincenas, hay adelantos y hay extras.

  /** Pagos del período, con el nombre del empleado ya resuelto. */
  async getPagosEmpleado(desde: string, hasta: string) {
    const { data, error } = await this.supabase
      .from('pagos_empleado')
      .select('*, empleados(nombre, activo)')
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async crearPagoEmpleado(datos: any) {
    const { data, error } = await this.supabase
      .from('pagos_empleado')
      .insert(datos)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async actualizarPagoEmpleado(id: number, datos: any) {
    const { data, error } = await this.supabase
      .from('pagos_empleado')
      .update(datos)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async eliminarPagoEmpleado(id: number) {
    const { error } = await this.supabase
      .from('pagos_empleado')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }

  // ── PAGOS A PROVEEDORES ───────────────────────────────────────
  //
  // Es un LIBRO DE ABONOS, no una marca de "pagada" sobre la compra: a los
  // proveedores se les paga por partes, así que una compra puede tener varios
  // abonos y el saldo se calcula comparando comprado contra pagado.
  //
  // Requiere la migración 013. Mientras no esté aplicada, estas llamadas tiran
  // error de PostgREST; `cargarDatos()` de Caja lo captura para que la pantalla
  // no quede en blanco.

  /** Abonos a proveedores del período, con el nombre ya resuelto. */
  async getPagosProveedor(desde: string, hasta: string) {
    const { data, error } = await this.supabase
      .from('pagos_proveedor')
      .select('*, proveedores(nombre, activo)')
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async crearPagoProveedor(datos: any) {
    const { data, error } = await this.supabase
      .from('pagos_proveedor')
      .insert(datos)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async actualizarPagoProveedor(id: number, datos: any) {
    const { data, error } = await this.supabase
      .from('pagos_proveedor')
      .update(datos)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async eliminarPagoProveedor(id: number) {
    const { error } = await this.supabase
      .from('pagos_proveedor')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }

  /**
   * Comisión sugerida de TODOS los empleados en un período, en una sola pasada.
   *
   * Existe para la caja: si la pantalla pidiera `calcularComisiones()` por
   * empleado, con 5 empleados serían 5 idas a la base para pintar una tabla.
   * Esta versión trae los turnos del período una vez y calcula en memoria, así
   * que el costo no crece con la cantidad de gente.
   *
   * Devuelve `[{ empleado_id, nombre, sugerido, turnos }]`. Los empleados sin
   * turnos en el período NO aparecen: para la caja no pagan nada.
   */
  async getComisionesPeriodo(desde: string, hasta: string) {
    const { data: turnos, error: eTurnos } = await this.supabase
      .from('turnos')
      .select('empleado_id, servicio_id, precio_final, precio')
      .eq('estado', 'atendido')
      .gte('fecha', desde)
      .lte('fecha', hasta);
    if (eTurnos) throw eTurnos;

    const ids = [...new Set((turnos || []).map((t: any) => t.empleado_id).filter(Boolean))];
    if (!ids.length) return [];

    const { data: empleados, error: eEmp } = await this.supabase
      .from('empleados')
      .select('id, nombre, comision_porcentaje')
      .in('id', ids);
    if (eEmp) throw eEmp;

    const { data: comisionServicio, error: eCom } = await this.supabase
      .from('comisiones_empleado')
      .select('empleado_id, servicio_id, porcentaje')
      .in('empleado_id', ids);
    if (eCom) throw eCom;

    // El porcentaje por servicio pisa al general, igual que en calcularComisiones.
    const porServicio = new Map<string, number>();
    (comisionServicio || []).forEach((c: any) => {
      porServicio.set(`${c.empleado_id}:${c.servicio_id}`, Number(c.porcentaje) || 0);
    });

    // Map por id: buscar con `.find()` adentro del forEach de turnos es O(n*m).
    const empPorId = new Map<number, any>((empleados || []).map((e: any) => [e.id, e]));

    const porEmpleado = new Map<number, { sugerido: number; turnos: number }>();
    (turnos || []).forEach((t: any) => {
      if (!t.empleado_id) return;
      const fila = porEmpleado.get(t.empleado_id) || { sugerido: 0, turnos: 0 };
      const general = Number(empPorId.get(t.empleado_id)?.comision_porcentaje) || 0;
      // Los paréntesis son obligatorios: mezclar `??` con `||` sin ellos es
      // error de sintaxis en JS.
      const pct = porServicio.get(`${t.empleado_id}:${t.servicio_id}`) ?? general;
      const precioReal = Number(t.precio_final || t.precio) || 0;
      fila.sugerido += (precioReal * pct) / 100;
      fila.turnos += 1;
      porEmpleado.set(t.empleado_id, fila);
    });

    return (empleados || [])
      .filter((e: any) => porEmpleado.has(e.id))
      .map((e: any) => ({
        empleado_id: e.id,
        nombre: e.nombre,
        sugerido: porEmpleado.get(e.id)!.sugerido,
        turnos: porEmpleado.get(e.id)!.turnos,
      }))
      .sort((a: any, b: any) => b.sugerido - a.sugerido);
  }

  // ── CAJA: PROVEEDORES Y COMPRAS ────────────────────────────

  async getProveedores(soloActivos = false) {
    let q = this.supabase.from('proveedores').select('*').order('nombre', { ascending: true });
    if (soloActivos) q = q.eq('activo', true);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async crearProveedor(datos: any) {
    const { data, error } = await this.supabase
      .from('proveedores')
      .insert(datos)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async actualizarProveedor(id: number, datos: any) {
    const { data, error } = await this.supabase
      .from('proveedores')
      .update(datos)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  /** Inactivar, no borrar: las compras viejas tienen que seguir apuntando a alguien. */
  async inactivarProveedor(id: number) {
    const { error } = await this.supabase
      .from('proveedores')
      .update({ activo: false })
      .eq('id', id);
    if (error) throw error;
  }

  /**
   * Reactivar un proveedor dado de baja. La contrapartida de `inactivarProveedor`.
   *
   * Va en el servicio y no como `actualizarProveedor(id, { activo: true })`
   * desde el componente para que quede el par de operaciones juntas y se lea
   * sola: si el menu de "inactivar" desaparece cuando el proveedor esta inactivo
   * (que es lo que pasa), el unico lugar desde donde volverlo es el panel de
   * detalle, y tiene que existir el metodo.
   */
  async activarProveedor(id: number) {
    const { error } = await this.supabase
      .from('proveedores')
      .update({ activo: true })
      .eq('id', id);
    if (error) throw error;
  }

  async eliminarProveedor(id: number) {
    const { error } = await this.supabase
      .from('proveedores')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }

  /** Compras del período, con el nombre del proveedor ya resuelto. */
  async getCompras(desde: string, hasta: string) {
    const { data, error } = await this.supabase
      .from('compras_proveedor')
      .select('*, proveedores(nombre, activo)')
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async crearCompra(datos: any) {
    const { data, error } = await this.supabase
      .from('compras_proveedor')
      .insert(datos)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async actualizarCompra(id: number, datos: any) {
    const { data, error } = await this.supabase
      .from('compras_proveedor')
      .update(datos)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async eliminarCompra(id: number) {
    const { error } = await this.supabase
      .from('compras_proveedor')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }
}