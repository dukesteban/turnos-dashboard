import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';

@Component({
  selector: 'app-configuracion',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './configuracion.html',
  styleUrls: ['./configuracion.scss']
})
export class ConfiguracionComponent implements OnInit {
  nombreNegocio = '';
  descripcion = '';
  horarios: any[] = [];
  guardando = false;
  mensaje = '';
  mensajeError = '';
  diasSemana = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  nuevoHorario = { dia_semana: 1, hora_inicio: '08:00', hora_fin: '12:00', activo: true };
  mostrarFormHorario = false;
  editandoDatos = false;
  puestosXTurno = 1;

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarDatos();
    this.cdr.detectChanges();
  }

  async cargarDatos() {
    const config = await this.supabase.getConfiguracion();
    this.nombreNegocio = config.find((c: any) => c.clave === 'nombre_negocio')?.valor || '';
    this.descripcion = config.find((c: any) => c.clave === 'descripcion')?.valor || '';
    this.puestosXTurno = parseInt(config.find((c: any) => c.clave === 'puestos_por_turno')?.valor) || 1;
    this.horarios = (await this.supabase.getHorarios()).map((h: any) => ({
      ...h,
      hora_inicio: h.hora_inicio?.slice(0, 5),
      hora_fin: h.hora_fin?.slice(0, 5),
      editando: false,
      editandoDatos: false
    }));
    this.cdr.detectChanges();
  }

  async toggleHorario(horario: any) {
    horario.activo = !horario.activo;
    await this.supabase.updateHorario(horario.id, { activo: horario.activo });
    this.cdr.detectChanges();
  }

  async guardarHorario(horario: any) {
    await this.supabase.updateHorario(horario.id, {
      hora_inicio: horario.hora_inicio,
      hora_fin: horario.hora_fin,
      activo: horario.activo
    });
    this.mensaje = '✅ Horario actualizado.';
    this.cdr.detectChanges();
  }

  async eliminarHorario(id: number) {
    if (!confirm('¿Eliminar este horario?')) return;
    await this.supabase.deleteHorario(id);
    this.horarios = this.horarios.filter(h => h.id !== id);
    this.cdr.detectChanges();
  }

  async agregarHorario() {
    const nuevo = await this.supabase.createHorario(this.nuevoHorario);
    this.horarios.push(nuevo);
    this.mostrarFormHorario = false;
    this.nuevoHorario = { dia_semana: 1, hora_inicio: '08:00', hora_fin: '12:00', activo: true };
    this.mensaje = '✅ Horario agregado.';
    this.cdr.detectChanges();
  }

  formatearHora(hora: string): string {
    return hora ? hora.slice(0, 5) : '';
  }

  getNombreDiaConTurno(horario: any): string {
    const dia = this.diasSemana[horario.dia_semana] || '';
    const inicio = parseInt(horario.hora_inicio?.slice(0, 2) || '0');
    const turno = inicio < 13 ? 'Mañana' : 'Tarde';
    return `${dia} ${turno}`;
  }

  async guardarConfiguracion() {
    this.guardando = true;
    this.mensaje = '';
    this.mensajeError = '';
    try {
      await this.supabase.upsertConfiguracion('nombre_negocio', this.nombreNegocio);
      await this.supabase.upsertConfiguracion('descripcion', this.descripcion);
      await this.supabase.upsertConfiguracion('puestos_por_turno', String(this.puestosXTurno));
      this.editandoDatos = false;
      this.mensaje = '✅ Configuración guardada correctamente.';
      setTimeout(() => { this.mensaje = ''; this.cdr.detectChanges(); }, 3000);
    } catch (e) {
      console.error(e);
      this.mensajeError = '❌ Error al guardar.';
    }
    this.guardando = false;
    this.cdr.detectChanges();
  }

  async cancelarConfiguracion() {
    await this.cargarDatos();
    this.editandoDatos = false;
  }
}