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
  mostrarIngresos = JSON.parse(sessionStorage.getItem('mostrarIngresos') ?? 'true');
  fechaTurnos: Date = new Date();
  
  // Popup
  turnoSeleccionado: any = null;
  mostrarPopup = false;
  horarios: any[] = [];
  servicios: any[] = [];
  mostrarPopupCancelacion = false;
  motivoCancelacion = '';
  enviandoMensaje = false;
  nombreNegocio = localStorage.getItem('nombre_negocio') || '';

  // Editar/Postergar
  modoEditarTurno = false;
  editandoTurno = false;
  errorEditarTurno = '';
  nuevaFecha = '';
  nuevaHora = '';
  nuevoServicioId: number | null = null;
  esperandoConfirmacion = false;
  mostrarPopupPostergacion = false;
  motivoPostergacion = '';
  enviandoMensajePostergacion = false;
  _nuevaFechaPostergacion = '';
  _nuevaHoraPostergacion = '';
  _nuevoServicioPostergacion = '';

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
    return this.servicios.find(s => s.id == Number(this.nuevoServicioId)) || null;
  }

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarTurnos();
    this.cdr.detectChanges();
  }

  async cargarTurnos() {
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
    const base = this.fechaTurnos;
    const formatLocal = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    if (this.vistasTurnos === 'semana') {
      const lunes = new Date(base);
      lunes.setDate(base.getDate() - (base.getDay() === 0 ? 6 : base.getDay() - 1));
      const domingo = new Date(lunes);
      domingo.setDate(lunes.getDate() + 6);
      return this.todosTurnos.filter(t => t.fecha >= formatLocal(lunes) && t.fecha <= formatLocal(domingo));
    } else {
      const y = base.getFullYear();
      const m = String(base.getMonth() + 1).padStart(2, '0');
      return this.todosTurnos.filter(t => t.fecha.startsWith(`${y}-${m}`));
    }
  }

  cambiarVistaTurnos(v: 'semana' | 'mes') {
    this.vistasTurnos = v;
    this.fechaTurnos = new Date(); // resetea al mes/semana actual
  }
  
  navegarTurnos(dir: number) {
    const d = new Date(this.fechaTurnos);
    if (this.vistasTurnos === 'semana') {
      d.setDate(d.getDate() + dir * 7);
    } else {
      d.setMonth(d.getMonth() + dir);
    }
    this.fechaTurnos = d;
  }
  
  irHoyTurnos() {
    this.fechaTurnos = new Date();
  }

  toggleIngresos() {
    this.mostrarIngresos = !this.mostrarIngresos;
    sessionStorage.setItem('mostrarIngresos', String(this.mostrarIngresos));
  }

  async cambiarEstado(id: number, estado: string) {
    await this.supabase.updateEstadoTurno(id, estado);
    await this.cargarTurnos();
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
    const id = this.turnoSeleccionado.id;
    await this.supabase.updateEstadoTurno(id, estado);
    await this.cargarTurnos();
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
    this.errorEditarTurno = '';
    if (!this.nuevaFecha || !this.nuevaHora || !this.nuevoServicioId) {
      this.errorEditarTurno = 'Completá todos los campos.';
      return;
    }
    const servicio = this.nuevoServicio;
    if (!servicio) return;

    this.editandoTurno = true;

    try {
      // Validar que no sea en el pasado — solo si el turno original es futuro
      const fechaHora = new Date(`${this.nuevaFecha}T${this.nuevaHora}`);
      /*
      const turnoOriginalFecha = new Date(`${this.turnoSeleccionado.fecha}T${this.turnoSeleccionado.hora_inicio || this.turnoSeleccionado.hora}`);
      if (turnoOriginalFecha > new Date()) {
        if (fechaHora <= new Date()) {
          this.errorEditarTurno = 'La nueva fecha y hora deben ser en el futuro.';
          return;
        }
      }
      */

      // Calcular hora fin
      const fin = new Date(fechaHora);
      fin.setMinutes(fin.getMinutes() + servicio.duracion_minutos);
      const horaFin = `${String(fin.getHours()).padStart(2,'0')}:${String(fin.getMinutes()).padStart(2,'0')}`;

      // Validar solapamiento
      const solapados = await this.supabase.getTurnosSolapados(
        this.nuevaFecha, this.nuevaHora, horaFin, this.turnoSeleccionado.id
      );
      const puestos = await this.supabase.getPuestosXTurno();
      if (solapados.length >= puestos) {
        this.errorEditarTurno = puestos === 1
          ? `Ya hay un turno de ${solapados[0].cliente_nombre} a esa hora.`
          : `Ya se alcanzó el límite de ${puestos} turnos simultáneos para ese horario.`;
        this.editandoTurno = false;
        this.cdr.detectChanges();
        return;
      }

      // Validar horario de atención
      const diaISO = new Date(this.nuevaFecha + 'T12:00:00').getDay();
      const horariosDia = this.horarios.filter((hor: any) => hor.dia_semana === diaISO && hor.activo);
      const dentroHorario = horariosDia.some((hor: any) => {
        return this.nuevaHora >= hor.hora_inicio.slice(0,5) && horaFin <= hor.hora_fin.slice(0,5);
      });
      if (!dentroHorario) {
        this.errorEditarTurno = 'El horario está fuera del horario de atención.';
        this.editandoTurno = false;
        this.cdr.detectChanges();
        return;
      }

      // Confirm DESPUÉS de validar
      //this.editandoTurno = false;
      //if (!confirm('¿Confirmar cambio de turno?')) return;
      //this.editandoTurno = true; 

      this.editandoTurno = false;
      await this.supabase.editarTurno(this.turnoSeleccionado.id, {
        fecha: this.nuevaFecha,
        hora: this.nuevaHora,
        horaFin,
        servicio_id: servicio.id,
        servicio_nombre: servicio.nombre,
        precio: servicio.precio,
        duracion_minutos: servicio.duracion_minutos
      });
      await this.cargarTurnos();
      await this.iniciarNotificacionPostergacion(this.nuevaFecha, this.nuevaHora, servicio.nombre);
    } catch (e) {
      console.error('Error en confirmarEditarTurno:', e);
      this.errorEditarTurno = '❌ Error al guardar. Intentá de nuevo.';
    }

    this.editandoTurno = false;
  }

  private formatearFechaCorta(fecha: Date): string {
    const d = String(fecha.getDate()).padStart(2, '0');
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    return `${d}/${m}`;
  }

  get rangoSemanaTurnos(): string {
    const base = this.fechaTurnos;
    const lunes = new Date(base);
    lunes.setDate(base.getDate() - (base.getDay() === 0 ? 6 : base.getDay() - 1));
    const domingo = new Date(lunes);
    domingo.setDate(lunes.getDate() + 6);
    return `${this.formatearFechaCorta(lunes)} — ${this.formatearFechaCorta(domingo)}`;
  }

  get tituloMesTurnos(): string {
    const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    return `${meses[this.fechaTurnos.getMonth()]} ${this.fechaTurnos.getFullYear()}`;
  }

  formatearHora(hora: string): string {
    return hora ? hora.slice(0, 5) : '';
  }

  formatearFecha(fecha: string): string {
    if (!fecha) return '';
    const [y, m, d] = fecha.split('-');
    return `${d}/${m}/${y}`;
  }

  formatearFechaSinAnio(fecha: string): string {
    if (!fecha) return '';
    const [y, m, d] = fecha.split('-');
    return `${d}/${m}`;
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
    const puestos = await this.supabase.getPuestosXTurno();
    if (solapados.length >= puestos) {
      this.errorEditarTurno = puestos === 1
        ? `Ya hay un turno de ${solapados[0].cliente_nombre} a esa hora.`
        : `Ya se alcanzó el límite de ${puestos} turnos simultáneos para ese horario.`;
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
    await this.cargarTurnos();
    this.cerrarModalNuevoTurno();
  }

  async crearYSeleccionarCliente() {
    if (!this.nombreNuevoCliente.trim()) return;

    const nombreNorm = this.supabase.normalizarNombre(this.nombreNuevoCliente);

    const duplicado = await this.supabase.verificarNombreDuplicado(nombreNorm);
    if (duplicado) {
      this.errorNuevoTurno = '❌ Ya existe un cliente con ese nombre.';
      return;
    }

    try {
      const cliente = await this.supabase.crearCliente(nombreNorm);
      this.seleccionarClienteNuevo({ ...cliente, telefonos: [] });
      this.mostrarFormNuevoCliente = false;
      this.nombreNuevoCliente = '';
    } catch (e) {
      this.errorNuevoTurno = '❌ Error al crear el cliente.';
    }
  }

  async iniciarCancelacion() {
    if (!this.turnoSeleccionado) return;
    await this.supabase.updateEstadoTurno(this.turnoSeleccionado.id, 'cancelado');
    if (confirm('¿Querés enviarle un mensaje de WhatsApp al cliente?'))
    {
      this.motivoCancelacion = '';
      this.mostrarPopupCancelacion = true;
    } else
    {
      this.mostrarPopupCancelacion = false;
      this.cerrarPopupCancelacion()
    }
    this.cdr.detectChanges();
  }

  async enviarMensajeCancelacion() {
    if (!this.turnoSeleccionado?.cliente_telefono) return;
    this.enviandoMensaje = true;
    try {
      const fecha = this.formatearFecha(this.turnoSeleccionado.fecha);
      const hora = this.formatearHora(this.turnoSeleccionado.hora_inicio || this.turnoSeleccionado.hora);
      const mensaje = `Estimado cliente:\nEl turno del día ${fecha} a las ${hora} hs ha sido cancelado debido a ${this.motivoCancelacion}.\nLamentamos los inconvenientes causados.\n(Si deseas reservar otro turno escribí *2* o *reservar*)\nAtte. ${this.nombreNegocio}`;
      await fetch('https://primary-production-4f919.up.railway.app/webhook/cancelacion-turno', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: this.turnoSeleccionado.cliente_telefono,
          type: 'text',
          text: { body: mensaje }
        })
      });
    } catch (e) {
      console.error('Error enviando mensaje:', e);
    }
    this.enviandoMensaje = false;
    this.mostrarPopupCancelacion = false;
    this.cerrarPopup();
    await this.cargarTurnos();
  }

  cerrarPopupCancelacion() {
    this.mostrarPopupCancelacion = false;
    this.cerrarPopup();
    this.cargarTurnos();
  }

  async iniciarNotificacionPostergacion(nuevaFecha: string, nuevaHora: string, nuevoServicio: string) {
    if (!this.turnoSeleccionado?.cliente_telefono) return;
    if (confirm('¿Querés enviarle un mensaje de WhatsApp al cliente?')) {
      this.motivoPostergacion = '';
      this._nuevaFechaPostergacion = nuevaFecha;
      this._nuevaHoraPostergacion = nuevaHora;
      this._nuevoServicioPostergacion = nuevoServicio;
      this.mostrarPopupPostergacion = true;
    } else {
      this.cerrarPopup();
      await this.cargarTurnos();
    }
    this.cdr.detectChanges();
  }

  async enviarMensajePostergacion() {
    this.enviandoMensajePostergacion = true;
    try {
      const fecha = this.formatearFecha(this._nuevaFechaPostergacion);
      const mensaje = `Estimado cliente:\nTu turno ha sido reprogramado para el día ${fecha} a las ${this._nuevaHoraPostergacion} hs (${this._nuevoServicioPostergacion}).${this.motivoPostergacion ? '\n' + this.motivoPostergacion : ''}\nLamentamos los inconvenientes causados.\n(Si deseas consultar tus turnos escribí *3* o *turnos*)\nAtte. ${this.nombreNegocio}`;
      await fetch('https://primary-production-4f919.up.railway.app/webhook/cancelacion-turno', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: this.turnoSeleccionado.cliente_telefono,
          type: 'text',
          text: { body: mensaje }
        })
      });
    } catch (e) {
      console.error('Error enviando mensaje:', e);
    }
    this.enviandoMensajePostergacion = false;
    this.mostrarPopupPostergacion = false;
    this.cerrarPopupPostergacion();
    await this.cargarTurnos();
  }

  cerrarPopupPostergacion() {
    this.mostrarPopupPostergacion = false;
    this.cerrarPopup();
    this.cargarTurnos();
  }
}