import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.html',
  styleUrls: ['./dashboard.scss']
})
export class DashboardComponent implements OnInit {
  turnosHoy: any[] = [];
  todosTurnos: any[] = [];
  totalIngresos = 0;
  totalClientes = 0;
  turnosPendientes = 0;
  vistasTurnos: 'semana' | 'mes' = 'semana';
  mostrarIngresos = true;
  
  // Popup
  turnoSeleccionado: any = null;
  mostrarPopup = false;
  horarios: any[] = [];
  servicios: any[] = [];

  // Editar/Postergar
  modoEditarTurno = false;
  editandoTurno = false;
  errorEditarTurno = '';
  nuevaFecha = '';
  nuevaHora = '';
  nuevoServicioId: number | null = null;

  // Nuevo turno
  mostrarModalNuevoTurno = false;
  clientesBuscados: any[] = [];
  clienteSeleccionadoNuevo: any = null;
  busquedaCliente = '';
  nuevoTurnoFecha = '';
  nuevoTurnoHora = '';
  nuevoTurnoServicioId: number | null = null;
  guardandoNuevoTurno = false;
  errorNuevoTurno = '';
  mostrarFormNuevoCliente = false;
  nombreNuevoCliente = '';

  get nuevoServicio(): any {
    return this.servicios.find(s => s.id == this.nuevoServicioId) || null;
  }

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarDatos();
    this.cdr.detectChanges();
  }

  async cargarDatos() {
    this.turnosHoy = await this.supabase.getTurnosHoy();
    this.todosTurnos = await this.supabase.getTurnos();

    this.totalIngresos = this.turnosHoy
      .filter((t: any) => t.estado === 'atendido')
      .reduce((sum: number, t: any) => sum + (Number(t.precio) || 0), 0);

    this.totalClientes = this.turnosHoy
      .filter((t: any) => t.estado === 'atendido').length;

    this.turnosPendientes = this.turnosHoy
      .filter((t: any) => t.estado === 'pendiente' && !this.esVencido(t)).length;

    this.cdr.detectChanges();
  }

  get turnosFiltrados(): any[] {
    const hoy = new Date();
    const formatLocal = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    if (this.vistasTurnos === 'semana') {
      const lunes = new Date(hoy);
      lunes.setDate(hoy.getDate() - (hoy.getDay() === 0 ? 6 : hoy.getDay() - 1));
      const domingo = new Date(lunes);
      domingo.setDate(lunes.getDate() + 6);
      return this.todosTurnos.filter(t => t.fecha >= formatLocal(lunes) && t.fecha <= formatLocal(domingo));
    } else {
      const y = hoy.getFullYear();
      const m = String(hoy.getMonth() + 1).padStart(2, '0');
      return this.todosTurnos.filter(t => t.fecha.startsWith(`${y}-${m}`));
    }
  }

  async cambiarEstado(id: number, estado: string) {
    await this.supabase.updateEstadoTurno(id, estado);
    await this.cargarDatos();
  }

  esVencido(turno: any): boolean {
    if (turno.estado !== 'pendiente') return false;
    const fechaHora = new Date(`${turno.fecha}T${turno.hora_inicio || turno.hora}`);
    return fechaHora < new Date();
  }

  async abrirPopup(turno: any) {
    this.turnoSeleccionado = turno;
    this.mostrarPopup = true;
    this.modoEditarTurno = false;
    this.errorEditarTurno = '';
    if (!this.servicios.length) this.servicios = await this.supabase.getServicios();
    if (!this.horarios.length) this.horarios = await this.supabase.getHorarios();
    this.cdr.detectChanges();
  }

  cerrarPopup() {
    this.mostrarPopup = false;
    this.turnoSeleccionado = null;
    this.modoEditarTurno = false;
    this.cdr.detectChanges();
  }

  async cambiarEstadoPopup(estado: string) {
    if (!this.turnoSeleccionado) return;
    await this.supabase.updateEstadoTurno(this.turnoSeleccionado.id, estado);
    await this.cargarDatos();
    this.cerrarPopup();
  }

  activarEditarTurno() {
    this.modoEditarTurno = true;
    this.nuevaFecha = this.turnoSeleccionado.fecha;
    this.nuevaHora = this.turnoSeleccionado.hora_inicio?.slice(0,5) || this.turnoSeleccionado.hora?.slice(0,5) || '';
    this.nuevoServicioId = this.turnoSeleccionado.servicio_id;
    this.errorEditarTurno = '';
    this.cdr.detectChanges();
  }

  async confirmarEditarTurno() {
    if (!confirm('¿Confirmar cambio de turno?')) return;
    if (!this.nuevaFecha || !this.nuevaHora || !this.nuevoServicioId) {
      this.errorEditarTurno = 'Completá todos los campos.';
      return;
    }
    const servicio = this.nuevoServicio;
    if (!servicio) return;

    const fechaHora = new Date(`${this.nuevaFecha}T${this.nuevaHora}`);
    const turnoOriginalFecha = new Date(`${this.turnoSeleccionado.fecha}T${this.turnoSeleccionado.hora_inicio || this.turnoSeleccionado.hora}`);
    if (turnoOriginalFecha > new Date()) {
      if (fechaHora <= new Date()) {
        this.errorEditarTurno = 'La nueva fecha y hora deben ser en el futuro.';
        return;
      }
    }

    const [h, m] = this.nuevaHora.split(':').map(Number);
    const fin = new Date(fechaHora);
    fin.setMinutes(fin.getMinutes() + servicio.duracion_minutos);
    const horaFin = `${String(fin.getHours()).padStart(2,'0')}:${String(fin.getMinutes()).padStart(2,'0')}`;

    const solapados = await this.supabase.getTurnosSolapados(
      this.nuevaFecha, this.nuevaHora, horaFin, this.turnoSeleccionado.id
    );
    if (solapados.length > 0) {
      this.errorEditarTurno = `Ya hay un turno de ${solapados[0].cliente_nombre} a esa hora.`;
      return;
    }

    const diaISO = new Date(this.nuevaFecha + 'T12:00:00').getDay();
    const horariosDia = this.horarios.filter((hor: any) => hor.dia_semana === diaISO && hor.activo);
    const dentroHorario = horariosDia.some((hor: any) => {
      return this.nuevaHora >= hor.hora_inicio.slice(0,5) && horaFin <= hor.hora_fin.slice(0,5);
    });
    if (!dentroHorario) {
      this.errorEditarTurno = 'El horario está fuera del horario de atención.';
      return;
    }

    this.editandoTurno = true;
    await this.supabase.editarTurno(this.turnoSeleccionado.id, {
      fecha: this.nuevaFecha,
      hora: this.nuevaHora,
      horaFin,
      servicio_id: servicio.id,
      servicio_nombre: servicio.nombre,
      precio: servicio.precio,
      duracion_minutos: servicio.duracion_minutos
    });
    this.editandoTurno = false;
    await this.cargarDatos();
    this.cerrarPopup();
  }

  formatearHora(hora: string): string {
    return hora ? hora.slice(0, 5) : '';
  }

  formatearFecha(fecha: string): string {
    if (!fecha) return '';
    const [y, m, d] = fecha.split('-');
    return `${d}/${m}/${y}`;
  }

  get nuevoTurnoServicio(): any {
    return this.servicios.find(s => s.id == this.nuevoTurnoServicioId) || null;
  }

  async buscarClientesNuevo() {
    if (!this.busquedaCliente.trim()) {
      this.clientesBuscados = [];
      return;
    }
    this.clientesBuscados = await this.supabase.buscarClientes(this.busquedaCliente);
    this.cdr.detectChanges();
  }

  seleccionarClienteNuevo(cliente: any) {
    this.clienteSeleccionadoNuevo = cliente;
    this.busquedaCliente = cliente.nombre;
    this.clientesBuscados = [];
    this.cdr.detectChanges();
  }

  abrirModalNuevoTurno() {
    this.mostrarModalNuevoTurno = true;
    this.clienteSeleccionadoNuevo = null;
    this.busquedaCliente = '';
    this.clientesBuscados = [];
    this.nuevoTurnoFecha = '';
    this.nuevoTurnoHora = '';
    this.nuevoTurnoServicioId = null;
    this.errorNuevoTurno = '';
    if (!this.servicios.length) this.supabase.getServicios().then(s => { this.servicios = s; this.cdr.detectChanges(); });
    if (!this.horarios.length) this.supabase.getHorarios().then(h => { this.horarios = h; this.cdr.detectChanges(); });
    this.cdr.detectChanges();
  }

  cerrarModalNuevoTurno() {
    this.mostrarModalNuevoTurno = false;
    this.cdr.detectChanges();
  }

  async guardarNuevoTurno() {
    if (!this.clienteSeleccionadoNuevo) { this.errorNuevoTurno = 'Seleccioná un cliente.'; return; }
    if (!this.nuevoTurnoFecha) { this.errorNuevoTurno = 'Ingresá una fecha.'; return; }
    if (!this.nuevoTurnoHora) { this.errorNuevoTurno = 'Ingresá una hora.'; return; }
    if (!this.nuevoTurnoServicioId) { this.errorNuevoTurno = 'Seleccioná un servicio.'; return; }

    const servicio = this.nuevoTurnoServicio;
    if (!servicio) return;

    // Calcular hora fin
    const fechaHora = new Date(`${this.nuevoTurnoFecha}T${this.nuevoTurnoHora}`);
    const fin = new Date(fechaHora);
    fin.setMinutes(fin.getMinutes() + servicio.duracion_minutos);
    const horaFin = `${String(fin.getHours()).padStart(2,'0')}:${String(fin.getMinutes()).padStart(2,'0')}`;

    // Validar solapamiento
    const solapados = await this.supabase.getTurnosSolapados(
      this.nuevoTurnoFecha, this.nuevoTurnoHora, horaFin, 0
    );
    if (solapados.length > 0) {
      this.errorNuevoTurno = `Ya hay un turno de ${solapados[0].cliente_nombre} a esa hora.`;
      return;
    }

    // Validar horario de atención
    const diaISO = new Date(this.nuevoTurnoFecha + 'T12:00:00').getDay();
    const horariosDia = this.horarios.filter((hor: any) => hor.dia_semana === diaISO && hor.activo);
    const dentroHorario = horariosDia.some((hor: any) =>
      this.nuevoTurnoHora >= hor.hora_inicio.slice(0,5) && horaFin <= hor.hora_fin.slice(0,5)
    );
    if (!dentroHorario) {
      this.errorNuevoTurno = 'El horario está fuera del horario de atención.';
      return;
    }

    const telefono = this.clienteSeleccionadoNuevo.telefonos?.[0]?.telefono || '';

    this.guardandoNuevoTurno = true;
    await this.supabase.crearTurnoManual({
      cliente_id: this.clienteSeleccionadoNuevo.id,
      cliente_nombre: this.clienteSeleccionadoNuevo.nombre,
      cliente_telefono: telefono,
      fecha: this.nuevoTurnoFecha,
      hora: this.nuevoTurnoHora,
      hora_inicio: this.nuevoTurnoHora,
      hora_fin: horaFin,
      servicio_id: servicio.id,
      servicio_nombre: servicio.nombre,
      precio: servicio.precio,
      duracion_minutos: servicio.duracion_minutos,
      estado: 'pendiente'
    });
    this.guardandoNuevoTurno = false;
    await this.cargarDatos();
    this.cerrarModalNuevoTurno();
  }

  async crearYSeleccionarCliente() {
    if (!this.nombreNuevoCliente.trim()) return;
    try {
      const cliente = await this.supabase.crearCliente(this.nombreNuevoCliente.trim());
      this.seleccionarClienteNuevo({ ...cliente, telefonos: [] });
      this.mostrarFormNuevoCliente = false;
      this.nombreNuevoCliente = '';
    } catch (e) {
      this.errorNuevoTurno = '❌ Error al crear el cliente.';
    }
  }
}