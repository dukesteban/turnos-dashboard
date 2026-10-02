import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';

const PX_POR_MINUTO = 1.2;
/** Alto del header de puestos (vista dia). Los turnos se corren esta cantidad. */
const H_HEADER_PUESTOS = 44;
/** Alto del header de puestos compactado (vista semana). */
const H_HEADER_MINI = 20;
/** Gutter horizontal entre columnas: debe coincidir con el margen del header. */
const GAP_COLUMNA = 3;

@Component({
  selector: 'app-agenda',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './agenda.html',
  styleUrls: ['./agenda.scss']
})
export class AgendaComponent implements OnInit, OnDestroy {
  private subscription: any;

  vista: 'dia' | 'semana' = 'dia';
  fechaActual: Date = new Date();
  turnos: any[] = [];

  // Puestos de trabajo (columnas de la agenda)
  puestos: any[] = [];
  /** Turnos sin puesto asignado -> columna gris al final */
  mostrarColumnaSinAsignar = false;

  horaInicio = 8;
  horaFin = 20;
  diaInicio = 1;
  diaFin = 6;

  diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  diasCompletos = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

  turnoSeleccionado: any = null;
  mostrarPopup = false;
  diasCerrados: any[] = [];
  metodosPago: any[] = [];
  modoAtendido = false;
  atendidoServicioId: any = null;
  atendidoPrecio: number = 0;
  atendidoMetodoPago = 'efectivo';
  atendidoObservaciones = '';
  guardandoAtendido = false;
  errorAtendido = '';
  
  // Editar/Postergar
  modoEditarTurno = false;
  servicios: any[] = [];
  empleados: any[] = [];
  comisionesPorServicio: any[] = [];
  editandoTurno = false;
  errorEditarTurno = '';
  nuevaFecha = '';
  nuevaHora = '';
  nuevoServicioId: number | null = null;
  nuevoEmpleadoId: number | null = null;
  horarios: any[] = [];
  esperandoConfirmacion = false;
  mostrarPopupCancelacion = false;
  motivoCancelacion = '';
  enviandoMensaje = false;
  nombreNegocio = localStorage.getItem('nombre_negocio') || '';
  mostrarPopupPostergacion = false;
  motivoPostergacion = '';
  enviandoMensajePostergacion = false;
  private subHorarios: any;
  _nuevaFechaPostergacion = '';
  _nuevaHoraPostergacion = '';
  _nuevoServicioPostergacion = '';
  atendidoEmpleadoId: number | null = null;

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarHorarios();
    await this.cargarPuestos();
    await this.cargarTurnos();
    this.metodosPago = await this.supabase.getMetodosPago();
    this.empleados = await this.supabase.getEmpleados();
    this.comisionesPorServicio = await this.supabase.getComisionesEmpleado(this.empleados.map((e: any) => e.id));
    this.diasCerrados = await this.supabase.getDiasCerrados();
    this.subscription = this.supabase.suscribirTurnos(() => {
      this.cargarTurnos();
    });
    this.subHorarios = this.supabase.suscribirHorarios(() => {
      this.cargarHorarios();
    });
    this.cdr.detectChanges();
  }

  getComisionEmpleadoServicio(empleadoId: number): number {
    if (!this.atendidoServicioId) return 0;
    const comision = this.comisionesPorServicio.find(
      (c: any) => c.empleado_id === empleadoId && c.servicio_id === this.atendidoServicioId
    );
    if (comision) return comision.porcentaje;
    const empleado = this.empleados.find((e: any) => e.id === empleadoId);
    return empleado?.comision_porcentaje || 0;
  }

  /**
   * Empleado real del turno. Los turnos viejos tienen puesto_id pero empleado_id
   * en null (se guardaban antes de que existieran los puestos), asi que cuando
   * falta se deriva del puesto que ya tiene asignado.
   */
  empleadoDeTurno(turno: any): number | null {
    if (!turno) return null;
    if (turno.empleado_id) return turno.empleado_id;
    const puesto = this.puestos.find((p: any) => p.id === turno.puesto_id);
    return puesto?.empleado_id || null;
  }

  /** Nombre del puesto del turno. Si falta puesto_id, lo deriva del empleado. */
  puestoDeTurno(turno: any): any {
    if (!turno) return null;
    if (turno.puesto_id) return this.puestos.find((p: any) => p.id === turno.puesto_id) || null;
    if (turno.empleado_id) return this.puestos.find((p: any) => p.empleado_id === turno.empleado_id) || null;
    return null;
  }

  nombrePuestoDeTurno(turno: any): string {
    return this.puestoDeTurno(turno)?.nombre || '—';
  }

  nombreEmpleadoDeTurno(turno: any): string {
    const id = this.empleadoDeTurno(turno);
    if (!id) return '—';
    return this.empleados.find((e: any) => e.id === id)?.nombre || '—';
  }

  actualizarVista() {
    this.cdr.detectChanges();
  }

  ngOnDestroy() {
    this.subscription?.unsubscribe();
    this.subHorarios?.unsubscribe();
  }

  toMinutos(horaStr: string): number {
    if (!horaStr) return 0;
    const parts = horaStr.split(':');
    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  }

  async cargarHorarios() {
    this.horarios = await this.supabase.getHorarios();
    const activos = (this.horarios || []).filter((h: any) => h.activo);
    if (activos.length > 0) {
      const inicios = activos.map((h: any) => {
        const parts = (h.hora_inicio || '08:00').split(':');
        return parseInt(parts[0], 10);
      });
      const fines = activos.map((h: any) => {
        const parts = (h.hora_fin || '20:00').split(':');
        const hora = parseInt(parts[0], 10);
        const min = parseInt(parts[1] || '0', 10);
        return min > 0 ? hora + 1 : hora;
      });

      this.horaInicio = Math.min(...inicios);
      this.horaFin = Math.max(...fines);
      this.diaInicio = Math.min(...activos.map((h: any) => Number(h.dia_semana)));
      this.diaFin = Math.max(...activos.map((h: any) => Number(h.dia_semana)));
    } else {
      this.horaInicio = 8;
      this.horaFin = 20;
      this.diaInicio = 1;
      this.diaFin = 6;
    }
    this.ajustarLimitesConTurnos();
    this.cdr.detectChanges();
  }

  async cargarTurnos() {
    this.turnos = await this.supabase.getTurnos();
    this.actualizarColumnaSinAsignar(this.turnos.filter((t: any) => t.fecha === this.fechaISO && t.estado !== 'cancelado'));
    this.ajustarLimitesConTurnos();
    this.cdr.detectChanges();
  }

  async cargarPuestos() {
    this.puestos = await this.supabase.getPuestos();
    this.cdr.detectChanges();
  }

  ajustarLimitesConTurnos() {
    if (!this.turnos?.length) return;
    this.turnos.forEach(t => {
      if (t.estado === 'cancelado') return;
      const hStr = t.hora_inicio || t.hora;
      if (hStr) {
        const h = parseInt(hStr.split(':')[0], 10);
        if (!isNaN(h) && h < this.horaInicio) {
          this.horaInicio = h;
        }
      }
      const finStr = t.hora_fin;
      if (finStr) {
        const parts = finStr.split(':');
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1] || '0', 10);
        const finH = m > 0 ? h + 1 : h;
        if (!isNaN(finH) && finH > this.horaFin) {
          this.horaFin = finH;
        }
      }
    });
  }

  esDiaCerrado(dia: Date): boolean {
    const fechaStr = dia.toLocaleDateString('en-CA');
    return this.diasCerrados.some(d => {
      const desde = d.fecha;
      const hasta = d.fecha_hasta || d.fecha;
      return fechaStr >= desde && fechaStr <= hasta;
    });
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

  /** Puestos activos en orden. Si hay turnos huerfanos, suma la columna "Sin asignar". */
  get columnasAgenda(): any[] {
    const cols = this.puestos.filter((p: any) => p.activo).map((p: any) => ({ puesto: p, sinAsignar: false }));
    if (this.mostrarColumnaSinAsignar) cols.push({ puesto: null, sinAsignar: true });
    return cols;
  }

  puestoAgendable(p: any): boolean {
    if (!p?.activo) return false;
    if (!p.empleado_id) return false;
    if (p.empleado && p.empleado.activo === false) return false;
    return true;
  }

  /** Actualiza la visibilidad de la columna gris segun si hay turnos sin puesto. */
  actualizarColumnaSinAsignar(turnosVisibles: any[]) {
    this.mostrarColumnaSinAsignar = turnosVisibles.some((t: any) => !t.puesto_id);
  }

  /** Indice de columna de un turno: la de su puesto, o la de "Sin asignar". */
  columnaDeTurno(turno: any): number {
    const cols = this.columnasAgenda;
    if (!cols.length) return 0;
    if (!turno?.puesto_id) return cols.length - 1;
    const idx = cols.findIndex((c: any) => !c.sinAsignar && c.puesto.id === turno.puesto_id);
    return idx >= 0 ? idx : cols.length - 1;
  }

  posicionTurno(turno: any, _columnas?: any, mini = false): { top: number, height: number, left: string, width: string } {
    const inicio = turno.hora_inicio || turno.hora || '00:00';
    const h = parseInt(inicio.slice(0, 2));
    const m = parseInt(inicio.slice(3, 5));
    const duracion = turno.duracion_minutos || 45;
    const minutosDesdeInicio = (h - this.horaInicio) * 60 + m;
    const offset = mini ? H_HEADER_MINI : H_HEADER_PUESTOS;

    const total = Math.max(this.columnasAgenda.length, 1);
    const col = Math.min(this.columnaDeTurno(turno), total - 1);
    const pct = 100 / total;

    return {
      // El +8 replica el margen de topParaHora: sin esto el bloque cae arriba de la linea.
      top: minutosDesdeInicio * PX_POR_MINUTO + offset + 8,
      height: Math.max(duracion * PX_POR_MINUTO - 6, 22),
      // El header usa flex:1 1 0 + margin 0 2px => misma geometria exacta que esto.
      left: `calc(${pct * col}% + ${GAP_COLUMNA}px)`,
      width: `calc(${pct}% - ${GAP_COLUMNA * 2}px)`
    };
  }

  /** Ancho de UNA columna de puesto, en px. Base de todo el layout. */
  get anchoColPuesto(): number {
    return this.vista === 'dia' ? 240 : 92;
  }

  get gapColumna(): number {
    return 4;
  }

  get anchoPuestos(): string {
    const n = Math.max(this.columnasAgenda.length, 1);
    return `${n * (this.anchoColPuesto + this.gapColumna)}px`;
  }

  /**
   * Ancho total de la grilla semanal. Se fija explicitamente para que el header
   * y el cuerpo midan EXACTAMENTE lo mismo (si no, los turnos se salen del dia).
   */
  get anchoGrillaSemana(): string {
    const nDias = this.diasDeSemana.length || 1;
    const nCols = Math.max(this.columnasAgenda.length, 1);
    return `${40 + nDias * nCols * (this.anchoColPuesto + this.gapColumna)}px`;
  }

  /** Offset vertical que dejan los headers de puestos. */
  get offsetHeader(): number {
    return this.vista === 'dia' ? H_HEADER_PUESTOS : H_HEADER_MINI;
  }

  /** Top de una linea de hora, ya descontado el alto del header. */
  topParaHoraConHeader(hora: number): number {
    return this.topParaHora(hora) + this.offsetHeader;
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
    this.modoAtendido = false;
    this.cdr.detectChanges();
  }

  async cambiarEstadoPopup(estado: string) {
    if (!this.turnoSeleccionado) return;
    if (estado === 'atendido') {
      this.modoAtendido = true;
      this.atendidoServicioId = this.turnoSeleccionado.servicio_id;
      this.atendidoMetodoPago = this.metodosPago[0]?.nombre || '';
      this.atendidoPrecio = this.turnoSeleccionado.precio;
      this.atendidoObservaciones = '';
      this.atendidoEmpleadoId = this.empleadoDeTurno(this.turnoSeleccionado);
      this.errorAtendido = '';
      return;
    }
    if (estado === 'pendiente') {
      const id = this.turnoSeleccionado.id;
      await this.supabase.volverAPendiente(id);
      await this.cargarTurnos(); // cargarDatos() en dashboard
      this.cerrarPopup();
      return;
    }
    const id = this.turnoSeleccionado.id;
    await this.supabase.updateEstadoTurno(id, estado);
    await this.cargarTurnos();
    this.cerrarPopup();
  }

  get atendidoServicio(): any {
    return this.servicios.find(s => s.id == this.atendidoServicioId) || null;
  }

  async confirmarAtendido() {
    this.errorAtendido = '';
    if (!this.atendidoServicioId || !this.atendidoPrecio || !this.atendidoMetodoPago) {
      this.errorAtendido = 'Completá los campos requeridos.';
      this.cdr.detectChanges();
      return;
    }
    const servicio = this.atendidoServicio;

    // Sin empleado no se puede guardar: se perderia la comision y el puesto quedaria huerfano.
    if (!this.atendidoEmpleadoId) {
      this.errorAtendido = '❌ Elegí el empleado que atendió.';
      this.cdr.detectChanges();
      return;
    }

    // El empleado elegido no puede pisar a otro turno de su mismo puesto
    const puestoId = await this.supabase.puestoDeEmpleado(this.atendidoEmpleadoId);
    if (!puestoId) {
      this.errorAtendido = '❌ Ese empleado no tiene un puesto asignado.';
      this.cdr.detectChanges();
      return;
    }
    const dur = servicio?.duracion_minutos || this.turnoSeleccionado.duracion_minutos || 45;
    const ocupado = await this.supabase.puestoEstaOcupado(
      puestoId,
      this.turnoSeleccionado.fecha,
      this.turnoSeleccionado.hora_inicio?.slice(0, 5) || this.turnoSeleccionado.hora?.slice(0, 5),
      dur,
      this.turnoSeleccionado.id
    );
    if (ocupado) {
      const nombreEmp = this.empleados.find((e: any) => e.id === this.atendidoEmpleadoId)?.nombre;
      this.errorAtendido = `❌ ${nombreEmp || 'Ese empleado'} ya tiene otro turno en ese horario.`;
      this.cdr.detectChanges();
      return;
    }

    this.guardandoAtendido = true;
    try {
      await this.supabase.marcarAtendido(this.turnoSeleccionado.id, {
        servicio_nombre_final: servicio?.nombre || this.turnoSeleccionado.servicio_nombre,
        servicio_id_final: servicio?.id ?? null,
        precio_final: this.atendidoPrecio,
        metodo_pago: this.atendidoMetodoPago,
        observaciones: this.atendidoObservaciones,
        empleado_id: this.atendidoEmpleadoId
      });
      await this.cargarTurnos();
      this.comisionesPorServicio = await this.supabase.getComisionesEmpleado(this.empleados.map((e: any) => e.id));
      this.cerrarPopup();
    } catch (e) {
      this.errorAtendido = '❌ Error al guardar.';
      this.cdr.detectChanges();
    }
    this.guardandoAtendido = false;
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
    this.nuevoEmpleadoId = this.empleadoDeTurno(this.turnoSeleccionado);
    this.errorEditarTurno = '';
    this.cdr.detectChanges();
  }

  async confirmarEditarTurno() {
    this.errorEditarTurno = '';
    if (!this.nuevaFecha || !this.nuevaHora || !this.nuevoServicioId) {
      this.errorEditarTurno = 'Completá todos los campos.';
      this.cdr.detectChanges();
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
      this.cdr.detectChanges();
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
          this.cdr.detectChanges();
          return;
        }
      }
      */

      // Calcular hora fin
      const fin = new Date(fechaHora);
      fin.setMinutes(fin.getMinutes() + servicio.duracion_minutos);
      const horaFin = `${String(fin.getHours()).padStart(2,'0')}:${String(fin.getMinutes()).padStart(2,'0')}`;

      // Validar que el puesto elegido no este ocupado en ese rango
      const puestoId = await this.supabase.puestoDeEmpleado(this.nuevoEmpleadoId);
      if (puestoId) {
        const ocupado = await this.supabase.puestoEstaOcupado(
          puestoId, this.nuevaFecha, this.nuevaHora,
          servicio.duracion_minutos, this.turnoSeleccionado.id
        );
        if (ocupado) {
          const nombreEmp = this.empleados.find((e: any) => e.id === this.nuevoEmpleadoId)?.nombre;
          this.errorEditarTurno = `❌ ${nombreEmp || 'Ese empleado'} ya tiene un turno en ese horario.`;
          this.editandoTurno = false;
          this.cdr.detectChanges();
          return;
        }
      } else if (this.nuevoEmpleadoId) {
        this.errorEditarTurno = '❌ Ese empleado no tiene un puesto asignado.';
        this.editandoTurno = false;
        this.cdr.detectChanges();
        return;
      }

      // Validar horario de atención
      const diaISO = new Date(this.nuevaFecha + 'T12:00:00').getDay();
      const horariosDia = this.horarios.filter((hor: any) => hor.dia_semana === diaISO && hor.activo);
      const dentroHorario = horariosDia.some((hor: any) => {
        const horIni = this.toMinutos(hor.hora_inicio);
        const horFin = this.toMinutos(hor.hora_fin);
        return this.toMinutos(this.nuevaHora) >= horIni && this.toMinutos(horaFin) <= horFin;
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
    if (this.turnoSeleccionado) {
      await this.supabase.updateEstadoTurno(this.turnoSeleccionado.id, 'cancelado');
      if (this.turnoSeleccionado.cliente_telefono &&
          confirm('¿Querés enviarle un mensaje de WhatsApp al cliente?')) {
        this.motivoCancelacion = '';
        this.mostrarPopupCancelacion = true;
      } else {
        this.cerrarPopupCancelacion();
        await this.cargarTurnos();
      }
    } else {
      this.cerrarPopupCancelacion();
      await this.cargarTurnos();
    }
    this.cdr.detectChanges();
  }

  async enviarMensajeCancelacion() {
    if (!this.turnoSeleccionado?.cliente_telefono) return;
    this.enviandoMensaje = true;
    try {
      const fecha = this.formatearFechaStr(this.turnoSeleccionado.fecha);
      const hora = this.formatearHora(this.turnoSeleccionado.hora_inicio || this.turnoSeleccionado.hora);
      const mensaje = `Estimado cliente:\n\n📆 El turno del día *${fecha}* a las *${hora}* hs ha sido *cancelado* debido a ${this.motivoCancelacion}.\nLamentamos los inconvenientes causados.😔\n_(Si deseas reservar otro turno escribí *1* o *reservar*)_\n\nAtte. *${this.nombreNegocio}*`;
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
    this.cdr.detectChanges();
  }

  cerrarPopupCancelacion() {
    this.mostrarPopupCancelacion = false;
    this.cerrarPopup();
  }

  async iniciarNotificacionPostergacion(nuevaFecha: string, nuevaHora: string, nuevoServicio: string) {
    const telefonoCliente = this.turnoSeleccionado?.cliente_telefono;
    if (!telefonoCliente) {
      this.cerrarPopup();
      await this.cargarTurnos();
    } else if (confirm('¿Querés enviarle un mensaje de WhatsApp al cliente?')) {
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
            const mensaje = `Estimado cliente:\n\n📆 Tu turno ha sido *reprogramado* para el día *${fecha}* a las *${this._nuevaHoraPostergacion}* hs (para un: *${this._nuevoServicioPostergacion}*).${this.motivoPostergacion ? this.motivoPostergacion + '.' : ''}\nLamentamos los inconvenientes causados.😔\n_(Si deseas consultar/cancelar tus turnos escribí *2* o *turnos*)_\n\nAtte. *${this.nombreNegocio}*`;
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
    this.cerrarPopupPostergacion();
    await this.cargarTurnos();
    this.cdr.detectChanges();
  }

  cerrarPopupPostergacion() {
    this.mostrarPopupPostergacion = false;
    this.cerrarPopup();
  }
 }
