import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SupabaseService } from '../../services/supabase';

const PX_POR_MINUTO = 1.2;

@Component({
  selector: 'app-agenda',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './agenda.html',
  styleUrls: ['./agenda.scss']
})
export class AgendaComponent implements OnInit {
  vista: 'dia' | 'semana' = 'dia';
  fechaActual: Date = new Date();
  turnos: any[] = [];

  horaInicio = 8;
  horaFin = 20;
  diaInicio = 1;
  diaFin = 6;

  diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  diasCompletos = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

  turnoSeleccionado: any = null;
  mostrarPopup = false;

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarHorarios();
    await this.cargarTurnos();
  }

  async cargarHorarios() {
    const horarios = await this.supabase.getHorarios();
    const activos = horarios.filter((h: any) => h.activo);
    if (activos.length > 0) {
      this.horaInicio = Math.min(...activos.map((h: any) => parseInt(h.hora_inicio.slice(0, 2))));
      this.horaFin = Math.max(...activos.map((h: any) => parseInt(h.hora_fin.slice(0, 2))));
      this.diaInicio = Math.min(...activos.map((h: any) => h.dia_semana));
      this.diaFin = Math.max(...activos.map((h: any) => h.dia_semana));
    }
    this.cdr.detectChanges();
  }

  async cargarTurnos() {
    this.turnos = await this.supabase.getTurnos();
    this.cdr.detectChanges();
  }

  // Altura total del contenedor en px
  get alturaTotal(): number {
    return (this.horaFin - this.horaInicio) * 60 * PX_POR_MINUTO;
  }

  // Filas de horas para las etiquetas
  get horasEtiquetas(): number[] {
    return Array.from({ length: this.horaFin - this.horaInicio + 1 }, (_, i) => this.horaInicio + i);
  }

  // Top en px para una hora dada
  topParaHora(hora: number): number {
    return (hora - this.horaInicio) * 60 * PX_POR_MINUTO;
  }

  // Posición y altura de un turno
  posicionTurno(turno: any): { top: number, height: number } {
    const inicio = turno.hora_inicio || turno.hora || '00:00';
    const h = parseInt(inicio.slice(0, 2));
    const m = parseInt(inicio.slice(3, 5));
    const duracion = turno.duracion_minutos || 45;
    const minutosDesdeInicio = (h - this.horaInicio) * 60 + m;
    return {
      top: minutosDesdeInicio * PX_POR_MINUTO,
      height: Math.max(duracion * PX_POR_MINUTO, 24)
    };
  }

  // VISTA DÍA
  get fechaISO(): string {
    return this.fechaActual.toISOString().split('T')[0];
  }

  get turnosDia(): any[] {
    return this.turnos.filter(t => t.fecha === this.fechaISO && t.estado !== 'cancelado');
  }

  // VISTA SEMANA
  get diasDeSemana(): Date[] {
    const inicio = new Date(this.fechaActual);
    const diaActual = inicio.getDay();
    const diff = diaActual === 0 ? -(7 - this.diaInicio) : this.diaInicio - diaActual;
    inicio.setDate(inicio.getDate() + diff);
    const cantidad = this.diaFin - this.diaInicio + 1;
    return Array.from({ length: cantidad }, (_, i) => {
      const d = new Date(inicio);
      d.setDate(inicio.getDate() + i);
      return d;
    });
  }

  turnosDeDia(dia: Date): any[] {
    const fechaStr = dia.toISOString().split('T')[0];
    return this.turnos.filter(t => t.fecha === fechaStr && t.estado !== 'cancelado');
  }

  // NAVEGACION
  navegarDia(dir: number) {
    const d = new Date(this.fechaActual);
    d.setDate(d.getDate() + dir);
    this.fechaActual = d;
  }

  navegarSemana(dir: number) {
    const d = new Date(this.fechaActual);
    d.setDate(d.getDate() + dir * 7);
    this.fechaActual = d;
  }

  irHoy() { this.fechaActual = new Date(); }

  formatearFecha(fecha: Date): string {
    const dia = this.diasCompletos[fecha.getDay()];
    const d = String(fecha.getDate()).padStart(2, '0');
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    return `${dia} ${d}/${m}`;
  }

  formatearFechaCorta(fecha: Date): string {
    const d = String(fecha.getDate()).padStart(2, '0');
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    return `${d}/${m}`;
  }

  esHoy(fecha: Date): boolean {
    const hoy = new Date().toISOString().split('T')[0];
    return fecha.toISOString().split('T')[0] === hoy;
  }

  // POPUP
  abrirPopup(turno: any) {
    this.turnoSeleccionado = turno;
    this.mostrarPopup = true;
    this.cdr.detectChanges();
  }

  cerrarPopup() {
    this.mostrarPopup = false;
    this.turnoSeleccionado = null;
    this.cdr.detectChanges();
  }

  async cambiarEstado(estado: string) {
    if (!this.turnoSeleccionado) return;
    await this.supabase.updateEstadoTurno(this.turnoSeleccionado.id, estado);
    await this.cargarTurnos();
    this.cerrarPopup();
  }

  getColorTurno(turno: any): string {
    if (turno.estado === 'atendido') return 'atendido';
    return 'pendiente';
  }

  formatearHora(inicio: string): string {
    return inicio?.slice(0, 5) || '';
  }
}
