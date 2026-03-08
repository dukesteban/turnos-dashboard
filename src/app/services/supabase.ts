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

  async getTurnos() {
    const { data, error } = await this.supabase
      .from('turnos')
      .select('*')
      .order('fecha', { ascending: true })
      .order('hora', { ascending: true });
    if (error) throw error;
    return data;
  }

  async getTurnosHoy() {
    const hoy = new Date().toISOString().split('T')[0];
    const { data, error } = await this.supabase
      .from('turnos')
      .select('*')
      .eq('fecha', hoy)
      .order('hora', { ascending: true });
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

  async agregarTelefono(clienteId: number, telefono: string) {
    const { data, error } = await this.supabase
      .from('telefonos')
      .insert({ cliente_id: clienteId, telefono, principal: false })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async eliminarTelefono(id: number) {
    const { error } = await this.supabase
      .from('telefonos')
      .delete()
      .eq('id', id);
    if (error) throw error;
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