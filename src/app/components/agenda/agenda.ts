import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SupabaseService } from '../../services/supabase';
import { FormsModule } from '@angular/forms';

const PX_POR_MINUTO = 1.2;

@Component({
  selector: 'app-agenda',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
  
  // Postergar
  modoPostergar = false;
  servicios: any[] = [];
  postergando = false;
  errorPostergar = '';
  nuevaFecha = '';
  nuevaHora = '';
  nuevoServicioId: number | null = null;
  horarios: any[] = [];

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarHorarios();
    await this.cargarTurnos();
  }

  async cargarHorarios() {
    this.horarios = await this.supabase.getHorarios();
    const activos = this.horarios.filter((h: any) => h.activo);
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
    return (hora - this.horaInicio) * 60 * PX_POR_MINUTO + 8;
  }

  // Posición y altura de un turno
  posicionTurno(turno: any): { top: number, height: number } {
    const inicio = turno.hora_inicio || turno.hora || '00:00';
    const h = parseInt(inicio.slice(0, 2));
    const m = parseInt(inicio.slice(3, 5));
    const duracion = turno.duracion_minutos || 45;
    const minutosDesdeInicio = (h - this.horaInicio) * 60 + m;
    return {
      top: minutosDesdeInicio * PX_POR_MINUTO + 8,
      height: Math.max(duracion * PX_POR_MINUTO, 24) - 9
    };
  }

  // VISTA DÍA
  get fechaISO(): string {
    return this.formatearFechaLocal(this.fechaActual);
  }

  formatearFechaLocal(fecha: Date): string {
    const y = fecha.getFullYear();
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    const d = String(fecha.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
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
    const fechaStr = this.formatearFechaLocal(dia);
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

  formatearFechaTurno(fecha: string): string {
    if (!fecha) return '';
    const [y, m, d] = fecha.split('-');
    return `${d}/${m}/${y}`;
  }

  esHoy(fecha: Date): boolean {
    return this.formatearFechaLocal(fecha) === this.formatearFechaLocal(new Date());
  }

  // POPUP
  async abrirPopup(turno: any) {
    this.turnoSeleccionado = turno;
    this.mostrarPopup = true;
    this.modoPostergar = false;
    this.errorPostergar = '';
    if (!this.servicios.length) {
      this.servicios = await this.supabase.getServicios();
    }
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

  esVencido(turno: any): boolean {
    if (turno.estado !== 'pendiente') return false;
    const fechaHora = new Date(`${turno.fecha}T${turno.hora_inicio || turno.hora}`);
    return fechaHora < new Date();
  }

  getColorTurno(turno: any): string {
    if (turno.estado === 'atendido') return 'atendido';
    if (this.esVencido(turno)) return 'vencido';
    return 'pendiente';
  }
  
  formatearHora(inicio: string): string {
    return inicio?.slice(0, 5) || '';
  }

  get nuevoServicio(): any {
    return this.servicios.find(s => s.id == this.nuevoServicioId) || null;
  }

  activarPostergar() {
    this.modoPostergar = true;
    this.nuevaFecha = this.turnoSeleccionado.fecha;
    this.nuevaHora = this.turnoSeleccionado.hora_inicio?.slice(0,5) || this.turnoSeleccionado.hora?.slice(0,5) || '';
    this.nuevoServicioId = this.turnoSeleccionado.servicio_id;
    this.errorPostergar = '';
    this.cdr.detectChanges();
  }

  async confirmarPostergar() {
    if (!this.nuevaFecha || !this.nuevaHora || !this.nuevoServicioId) {
      this.errorPostergar = 'Completá todos los campos.';
      return;
    }
    const servicio = this.nuevoServicio;
    if (!servicio) return;

    // Validar que no sea en el pasado
    const fechaHora = new Date(`${this.nuevaFecha}T${this.nuevaHora}`);
    if (fechaHora <= new Date()) {
      this.errorPostergar = 'La nueva fecha y hora deben ser en el futuro.';
      return;
    }

    // Calcular hora fin
    const [h, m] = this.nuevaHora.split(':').map(Number);
    const fin = new Date(fechaHora);
    fin.setMinutes(fin.getMinutes() + servicio.duracion_minutos);
    const horaFin = `${String(fin.getHours()).padStart(2,'0')}:${String(fin.getMinutes()).padStart(2,'0')}`;

    // Validar solapamiento
    const solapados = await this.supabase.getTurnosSolapados(
      this.nuevaFecha, this.nuevaHora, horaFin, this.turnoSeleccionado.id
    );
    if (solapados.length > 0) {
      this.errorPostergar = `Ya hay un turno de ${solapados[0].cliente_nombre} a esa hora.`;
      return;
    }

    // Validar horario de atención
    const diaISO = new Date(this.nuevaFecha + 'T12:00:00').getDay();
    const horariosDia = this.horarios.filter((hor: any) => hor.dia_semana === diaISO && hor.activo);
    const dentroHorario = horariosDia.some((hor: any) => {
      return this.nuevaHora >= hor.hora_inicio.slice(0,5) && horaFin <= hor.hora_fin.slice(0,5);
    });
    if (!dentroHorario) {
      this.errorPostergar = 'El horario está fuera del horario de atención.';
      return;
    }

    this.postergando = true;
    await this.supabase.postergarTurno(this.turnoSeleccionado.id, {
      fecha: this.nuevaFecha,
      hora: this.nuevaHora,
      horaFin,
      servicio_id: servicio.id,
      servicio_nombre: servicio.nombre,
      precio: servicio.precio,
      duracion_minutos: servicio.duracion_minutos
    });
    this.postergando = false;
    await this.cargarTurnos();
    this.cerrarPopup();
  }
}
