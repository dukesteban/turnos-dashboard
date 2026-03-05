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
}
