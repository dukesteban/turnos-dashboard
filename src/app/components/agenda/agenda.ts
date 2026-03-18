import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';

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
  puestosXTurno = 1;
  
  // Editar/Postergar
  modoEditarTurno = false;
  servicios: any[] = [];
  editandoTurno = false;
  errorEditarTurno = '';
  nuevaFecha = '';
  nuevaHora = '';
  nuevoServicioId: number | null = null;
  horarios: any[] = [];
  esperandoConfirmacion = false;
  mostrarPopupCancelacion = false;
  motivoCancelacion = '';
  enviandoMensaje = false;
  nombreNegocio = localStorage.getItem('nombre_negocio') || '';
  mostrarPopupPostergacion = false;
  motivoPostergacion = '';
  enviandoMensajePostergacion = false;
  _nuevaFechaPostergacion = '';
  _nuevaHoraPostergacion = '';
  _nuevoServicioPostergacion = '';

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarHorarios();
    await this.cargarTurnos();
    this.puestosXTurno = await this.supabase.getPuestosXTurno();
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

  calcularColumnas(turnos: any[]): Map<number, { col: number, total: number }> {
    const resultado = new Map<number, { col: number, total: number }>();

    const toMin = (t: any) => {
      const h = t.hora_inicio || t.hora || '00:00';
      return parseInt(h.slice(0,2)) * 60 + parseInt(h.slice(3,5));
    };
    const toFin = (t: any) => toMin(t) + (t.duracion_minutos || 45);

    // Ordenar por hora de inicio para que el más temprano tome col 0
    const ordenados = [...turnos].sort((a, b) => toMin(a) - toMin(b));

    ordenados.forEach((t) => {
      const ini = toMin(t);
      const fin = toFin(t);
      const solapados = turnos.filter(u => {
        if (u.id === t.id) return false;
        return toMin(u) < fin && toFin(u) > ini;
      });

      const total = solapados.length + 1;

      // Asignar la primera columna libre
      const colsUsadas = solapados
        .filter(u => resultado.has(u.id))
        .map(u => resultado.get(u.id)!.col);
      let col = 0;
      while (colsUsadas.includes(col)) col++;

      resultado.set(t.id, { col, total });
    });

    // Normalizar total al máximo real del grupo
    resultado.forEach((val, id) => {
      const t = turnos.find(x => x.id === id)!;
      const ini = toMin(t);
      const fin = toFin(t);
      const maxTotal = Math.max(...turnos
        .filter(u => toMin(u) < fin && toFin(u) > ini)
        .map(u => resultado.get(u.id)?.total || 1), val.total);
      resultado.set(id, { ...val, total: maxTotal });
    });

    return resultado;
  }

  posicionTurno(turno: any, columnas?: Map<number, { col: number, total: number }>, mini = false): { top: number, height: number, left: string, width: string } {
    const inicio = turno.hora_inicio || turno.hora || '00:00';
    const h = parseInt(inicio.slice(0, 2));
    const m = parseInt(inicio.slice(3, 5));
    const duracion = turno.duracion_minutos || 45;
    const minutosDesdeInicio = (h - this.horaInicio) * 60 + m;

    let left = '0%';
    let width = '100%';
    if (columnas?.has(turno.id)) {
      const { col, total } = columnas.get(turno.id)!;
      const esMobile = window.innerWidth <= 640;
      if (total === 1) {
        width = mini ? 'calc(100% - 13.5px)' : (esMobile ? 'calc(100% - 18.5px)' : 'calc(100% - 18.5px)');
        left = '0px';
      } else {
          const pct = 100 / total;
          width = mini ? `calc(${pct}% - 12.5px)` : `calc(${pct}% - 18.5px)`
          left = `calc(${pct * col}% + 0px)`;
        }
    }

    return {
      top: minutosDesdeInicio * PX_POR_MINUTO + 8,
      height: Math.max(duracion * PX_POR_MINUTO, 24) + (mini ? -7 : -9),
      left,
      width
    };
  }

  get anchoPuestos(): string {
    return `${this.puestosXTurno * 80}px`;
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

  formatearFechaStr(fecha: string): string {
    if (!fecha) return '';
    const [y, m, d] = fecha.split('-');
    return `${d}/${m}/${y}`;
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
    this.modoEditarTurno = false;
    this.errorEditarTurno = '';
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

  async cambiarEstadoPopup(estado: string) {
    if (!this.turnoSeleccionado) return;
    const id = this.turnoSeleccionado.id;
    await this.supabase.updateEstadoTurno(id, estado);
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
    return this.servicios.find(s => s.id == Number(this.nuevoServicioId)) || null;
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

    // Verificar si hubo cambios
    /*
    const sinCambios = 
      this.nuevaFecha === this.turnoSeleccionado.fecha &&
      this.nuevaHora === (this.turnoSeleccionado.hora_inicio || this.turnoSeleccionado.hora)?.slice(0, 5) &&
      Number(this.nuevoServicioId) === this.turnoSeleccionado.servicio_id;

    if (sinCambios) {
      this.errorEditarTurno = 'No realizaste ningún cambio.';
      return;
    }
    */
   
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
      const fecha = this.formatearFechaStr(this.turnoSeleccionado.fecha);
      const hora = this.formatearHora(this.turnoSeleccionado.hora_inicio || this.turnoSeleccionado.hora);
      const mensaje = `Estimado cliente:\n\nEl turno del día *${fecha}* a las *${hora}* hs ha sido *cancelado* debido a ${this.motivoCancelacion}.\nLamentamos los inconvenientes causados.\n_(Si deseas reservar otro turno escribí *2* o *reservar*)_\n\nAtte. ${this.nombreNegocio}`;
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
      const fecha = this.formatearFechaStr(this._nuevaFechaPostergacion);
            const mensaje = `Estimado cliente:\n\nTu turno ha sido *reprogramado* para el día *${fecha}* a las *${this._nuevaHoraPostergacion}* hs (para un: *${this._nuevoServicioPostergacion}*).${this.motivoPostergacion ? this.motivoPostergacion + '.' : ''}\nLamentamos los inconvenientes causados.\n_(Si deseas consultar/cancelar tus turnos escribí *3* o *turnos*)_\n\nAtte. ${this.nombreNegocio}`;
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
