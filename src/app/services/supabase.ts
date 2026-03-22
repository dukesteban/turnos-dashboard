import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

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
    const { error } = await this.supabase
      .from('turnos')
      .update({
        fecha: datos.fecha,
        hora: horaInicio,
        hora_inicio: horaInicio,
        hora_fin: horaFin,
        servicio_id: datos.servicio_id,
        servicio_nombre: datos.servicio_nombre,
        precio: datos.precio,
        duracion_minutos: datos.duracion_minutos
      })
      .eq('id', id);
    if (error) throw error;
  }

  async getTurnosSolapados(fecha: string, horaInicio: string, horaFin: string, excludeId: number) {
    const ini = horaInicio.length === 5 ? horaInicio + ':00' : horaInicio;
    const fin = horaFin.length === 5 ? horaFin + ':00' : horaFin;
    const { data, error } = await this.supabase
      .from('turnos')
      .select('*')
      .eq('fecha', fecha)
      .neq('estado', 'cancelado')
      .neq('id', excludeId)
      .lt('hora_inicio', fin)
      .gt('hora_fin', ini);
    if (error) throw error;
    return data;
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

  async getPuestosXTurno(): Promise<number> {
    const { data, error } = await this.supabase
      .from('configuracion')
      .select('valor')
      .eq('clave', 'puestos_por_turno')
      .single();
    if (error) return 1;
    return parseInt(data?.valor) || 1;
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
      .order('nombre', { ascending: true });
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

  async buscarClientes(query: string) {
    const { data, error } = await this.supabase
      .from('clientes')
      .select('*, telefonos(*)')
      .ilike('nombre', `%${query}%`)
      .limit(5);
    if (error) throw error;
    return data;
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

  async actualizarTelefonoEnTurnos(clienteId: number, telefono: string) {
    const { error } = await this.supabase
      .from('turnos')
      .update({ cliente_telefono: telefono })
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
}