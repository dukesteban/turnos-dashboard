import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';
import { problemaTelefono } from '../../utils/telefono';
import {
  nombreMes, normalizarJornada, DIAS, SlotJornada,
  turnoTocadoPorAusencia, textoAusencia, jornadaCubre,
} from '../../utils/fechas';

/** Jornada por defecto: lunes a viernes, sin tope horario. */
function jornadaVaciaPorDefecto(): SlotJornada[] {
  return normalizarJornada([false, true, true, true, true, true, false]);
}

function AusenciaVacia() {
  return {
    desde: '', hasta: '',
    hora_inicio: '', hora_fin: '',
    tipo: 'vacaciones', motivo: '',
  };
}

@Component({
  selector: 'app-empleados',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './empleados.html',
  styleUrls: ['./empleados.scss']
})
export class EmpleadosComponent implements OnInit {
  empleados: any[] = [];
  empleadoSeleccionado: any = null;
  mensaje = '';
  mensajeError = '';
  busqueda = '';
  vistaComisiones: 'dia' | 'semana' | 'mes' = 'dia';
  fechaComision: Date = new Date();

  // Formulario
  nuevoNombre = '';
  nuevoTelefono = '';
  nuevaComision = 10;
  /** Jornada por defecto: L-V. Un dia con horas vacias = jornada completa. */
  jornadaDefault: SlotJornada[] = jornadaVaciaPorDefecto();
  jornadaNueva: SlotJornada[] = jornadaVaciaPorDefecto();
  mostrarModalNuevoEmpleado = false;
  guardandoNuevoEmpleado = false;
  errorNuevoEmpleado = '';

  diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  diasCompletos = DIAS;

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarEmpleados();
    this.cdr.detectChanges();
  }

  async cargarEmpleados() {
    const data = await this.supabase.getEmpleados();
    this.empleados = data.map((e: any) => ({
      ...e,
      jornada: normalizarJornada(e.jornada),
    }));
    this.cdr.detectChanges();
  }

  get empleadosFiltrados(): any[] {
    if (!this.busqueda) return this.empleados;
    const q = this.busqueda.toLowerCase();
    return this.empleados.filter(e =>
      e.nombre?.toLowerCase().includes(q) ||
      e.telefono?.includes(q)
    );
  }

  abrirModalNuevoEmpleado() {
    this.mostrarModalNuevoEmpleado = true;
    this.nuevoNombre = '';
    this.nuevoTelefono = '';
    this.nuevaComision = 10;
    this.jornadaNueva = jornadaVaciaPorDefecto();
    this.errorNuevoEmpleado = '';
    this.cdr.detectChanges();
  }

  cerrarModalNuevoEmpleado() {
    this.mostrarModalNuevoEmpleado = false;
    this.cdr.detectChanges();
  }

  async agregarEmpleado() {
    if (!this.nuevoNombre.trim()) {
      this.errorNuevoEmpleado = '❌ Ingresá un nombre.';
      this.cdr.detectChanges();
      return;
    }
    this.guardandoNuevoEmpleado = true;
    this.errorNuevoEmpleado = '';
    // El teléfono es opcional, pero si se escribe tiene que parecer un teléfono.
    if (this.nuevoTelefono.trim()) {
      const problema = problemaTelefono(this.nuevoTelefono);
      if (problema) {
        this.errorNuevoEmpleado = problema;
        this.guardandoNuevoEmpleado = false;
        this.cdr.detectChanges();
        return;
      }
    }
    try {
      const empleado = await this.supabase.crearEmpleado({
        nombre: this.nuevoNombre.trim(),
        telefono: this.nuevoTelefono.trim() || null,
        comision_porcentaje: this.nuevaComision,
        jornada: this.jornadaNueva
      });
      this.empleados.push(empleado);
      this.nuevoNombre = '';
      this.nuevoTelefono = '';
      this.nuevaComision = 10;
      this.jornadaNueva = jornadaVaciaPorDefecto();
      this.cerrarModalNuevoEmpleado();
      this.mostrarMensaje('✅ Empleado agregado.');
    } catch (e: any) {
      console.error('Error al agregar empleado:', e);
      this.errorNuevoEmpleado = `❌ Error: ${e.message || 'No se pudo agregar'}`;
    }
    this.guardandoNuevoEmpleado = false;
    this.cdr.detectChanges();
  }

  async seleccionarEmpleado(empleado: any) {
    const jornada = normalizarJornada(empleado.jornada);
    this.empleadoSeleccionado = {
      ...empleado,
      jornada,
      _jornadaOrig: JSON.parse(JSON.stringify(jornada)),
      editando: false,
    };
    await this.cargarComisiones();
    await this.cargarComisionesPorServicio();
    await this.cargarAusencias();
    await this.cargarTurnosEnRiesgo();
    this.cdr.detectChanges();
  }

  async cargarComisionesPorServicio() {
    if (!this.empleadoSeleccionado) {
      this.comisionesPorServicio = [];
      return;
    }
    this.comisionesPorServicio = await this.supabase.getComisionesEmpleado(this.empleadoSeleccionado.id);
    if (!this.servicios.length) {
      this.servicios = await this.supabase.getServicios();
    }
    this.cdr.detectChanges();
  }

  getComisionServicio(servicioId: number): number {
    const comision = this.comisionesPorServicio.find(c => c.servicio_id === servicioId);
    return comision?.porcentaje ?? this.empleadoSeleccionado?.comision_porcentaje ?? 0;
  }

  editarComisionServicio(servicioId: number) {
    this.editandoComisionServicio = servicioId;
    this.nuevaComisionServicio = this.getComisionServicio(servicioId);
    this.cdr.detectChanges();
  }

  async guardarComisionServicio(servicioId: number) {
    if (!this.empleadoSeleccionado || this.empleadoSeleccionado.guardando) return;
    const emp = this.empleadoSeleccionado;
    emp.guardando = true;
    this.cdr.detectChanges();
    try {
      await this.supabase.upsertComisionEmpleado(emp.id, servicioId, this.nuevaComisionServicio);
      await this.cargarComisionesPorServicio();
      this.editandoComisionServicio = null;
      this.mostrarMensaje('✅ Comisión actualizada.');
    } catch (e) {
      this.mostrarError('❌ Error al guardar la comisión.');
    } finally {
      emp.guardando = false;
      this.cdr.detectChanges();
    }
  }

  async eliminarComisionServicio(servicioId: number) {
    if (!this.empleadoSeleccionado) return;
    if (!confirm('¿Eliminar esta comisión personalizada?')) return;
    try {
      await this.supabase.deleteComisionEmpleado(this.empleadoSeleccionado.id, servicioId);
      await this.cargarComisionesPorServicio();
      this.mostrarMensaje('✅ Comisión eliminada.');
    } catch (e) {
      this.mostrarError('❌ Error al eliminar la comisión.');
    }
  }

  cerrarDetalle() {
    this.empleadoSeleccionado = null;
    this.cdr.detectChanges();
  }

  async guardarNombre() {
    if (!this.empleadoSeleccionado || this.empleadoSeleccionado.guardando) return;
    const emp = this.empleadoSeleccionado;
    emp.guardando = true;
    this.cdr.detectChanges();
    try {
      await this.supabase.updateEmpleado(emp.id, { nombre: emp.nombre.trim() });
      const idx = this.empleados.findIndex(e => e.id === emp.id);
      if (idx >= 0) this.empleados[idx].nombre = emp.nombre.trim();
      emp.editando = false;
      this.mostrarMensaje('✅ Nombre actualizado.');
    } catch (e) {
      this.mostrarError('❌ Error al actualizar.');
    } finally {
      emp.guardando = false;
      this.cdr.detectChanges();
    }
  }

  async guardarTelefono() {
    if (!this.empleadoSeleccionado || this.empleadoSeleccionado.guardando) return;
    const emp = this.empleadoSeleccionado;
    emp.guardando = true;
    this.cdr.detectChanges();
    try {
      await this.supabase.updateEmpleado(emp.id, { telefono: emp.telefono?.trim() || null });
      const idx = this.empleados.findIndex(e => e.id === emp.id);
      if (idx >= 0) this.empleados[idx].telefono = emp.telefono;
      emp.editandoTelefono = false;
      this.mostrarMensaje('✅ Teléfono actualizado.');
    } catch (e) {
      this.mostrarError('❌ Error al actualizar.');
    } finally {
      emp.guardando = false;
      this.cdr.detectChanges();
    }
  }

  async guardarComision() {
    if (!this.empleadoSeleccionado || this.empleadoSeleccionado.guardando) return;
    const emp = this.empleadoSeleccionado;
    emp.guardando = true;
    this.cdr.detectChanges();
    try {
      await this.supabase.updateEmpleado(emp.id, { comision_porcentaje: emp.comision_porcentaje });
      const idx = this.empleados.findIndex(e => e.id === emp.id);
      if (idx >= 0) this.empleados[idx].comision_porcentaje = emp.comision_porcentaje;
      emp.editandoComision = false;
      this.mostrarMensaje('✅ Comisión actualizada.');
    } catch (e) {
      this.mostrarError('❌ Error al actualizar.');
    } finally {
      emp.guardando = false;
      this.cdr.detectChanges();
    }
  }

  async guardarJornada() {
    if (!this.empleadoSeleccionado || this.empleadoSeleccionado.guardando) return;
    const emp = this.empleadoSeleccionado;
    // Normalizar antes de guardar: un slot con horas pero sin activo no tiene sentido.
    const jornada = normalizarJornada(emp.jornada).map((s: SlotJornada) =>
      s.activo ? s : { activo: false, hora_inicio: null, hora_fin: null }
    );
    emp.guardando = true;
    this.cdr.detectChanges();
    try {
      await this.supabase.updateEmpleado(emp.id, { jornada });
      const idx = this.empleados.findIndex(e => e.id === emp.id);
      if (idx >= 0) this.empleados[idx].jornada = jornada;
      emp.jornada = jornada;
      emp.editandoJornada = false;
      // Cambiar la jornada puede SACAR turnos de riesgo o meterlos.
      await this.cargarTurnosEnRiesgo();
      this.mostrarMensaje('✅ Jornada actualizada.');
    } catch (e) {
      this.mostrarError('❌ Error al actualizar.');
    } finally {
      emp.guardando = false;
      this.cdr.detectChanges();
    }
  }

  cancelarJornada() {
    const emp = this.empleadoSeleccionado;
    if (!emp) return;
    emp.jornada = emp._jornadaOrig
      ? normalizarJornada(JSON.parse(JSON.stringify(emp._jornadaOrig)))
      : normalizarJornada(emp.jornada);
    emp.editandoJornada = false;
    this.mostrarError('');
    this.cdr.detectChanges();
  }

  /** Un dia activo sin tope horario trabaja todo el dia. */
  limpiarHorario(i: number) {
    const s = this.empleadoSeleccionado?.jornada?.[i];
    if (!s) return;
    s.hora_inicio = null;
    s.hora_fin = null;
    this.cdr.detectChanges();
  }

  limpiarHorarioNueva(i: number) {
    const s = this.jornadaNueva?.[i];
    if (!s) return;
    s.hora_inicio = null;
    s.hora_fin = null;
    this.cdr.detectChanges();
  }

  /**
   * Desactivar un dia. Antes el checkbox usaba [ngModel] (unidireccional) y en
   * el ngModelChange solo se limpiaba hora_fin: `activo` nunca pasaba a false,
   * asi que el dia seguia marcado y los horarios quedaban a la vista.
   */
  desactivarDia(i: number) {
    const s = this.empleadoSeleccionado?.jornada?.[i];
    if (!s) return;
    s.activo = false;
    s.hora_inicio = null;
    s.hora_fin = null;
    this.cdr.detectChanges();
  }

  desactivarDiaNueva(i: number) {
    const s = this.jornadaNueva?.[i];
    if (!s) return;
    s.activo = false;
    s.hora_inicio = null;
    s.hora_fin = null;
    this.cdr.detectChanges();
  }

  activarDiaNueva(i: number) {
    const s = this.jornadaNueva?.[i];
    if (!s) return;
    s.activo = true;
    if (!s.hora_fin) { s.hora_inicio = '08:00'; s.hora_fin = '17:00'; }
    this.cdr.detectChanges();
  }

  /** Al activar un dia, se le pone un tope por defecto util (08:00-17:00). */
  activarDia(i: number) {
    const s = this.empleadoSeleccionado?.jornada?.[i];
    if (!s) return;
    s.activo = true;
    if (!s.hora_fin) { s.hora_inicio = '08:00'; s.hora_fin = '17:00'; }
    this.cdr.detectChanges();
  }

  get resumenJornada(): string {
    const j = normalizarJornada(this.empleadoSeleccionado?.jornada);
    const activos = j.filter(s => s.activo);
    if (!activos.length) return 'No trabaja ningún día';
    const conTope = activos.filter(s => s.hora_fin).length;
    const nombres = j
      .map((s, i) => (s.activo ? this.diasSemana[i] : null))
      .filter(Boolean).join(' ');
    return conTope
      ? `${nombres} · ${conTope} con horario parcial`
      : `${nombres} · jornada completa`;
  }

  async inactivarEmpleado() {
    if (!this.empleadoSeleccionado) return;
    if (!confirm(`¿Inactivar a ${this.empleadoSeleccionado.nombre}?`)) return;
    try {
      await this.supabase.updateEmpleado(this.empleadoSeleccionado.id, { activo: false });
      const idx = this.empleados.findIndex(e => e.id === this.empleadoSeleccionado.id);
      if (idx >= 0) this.empleados[idx].activo = false;
      this.cerrarDetalle();
      this.mostrarMensaje('✅ Empleado inactivado.');
    } catch (e) {
      this.mostrarError('❌ Error al inactivar.');
    }
  }

  // COMISIONES
  get fechaComisionISO(): string {
    return this.formatearFechaLocal(this.fechaComision);
  }

  formatearFechaLocal(fecha: Date): string {
    const y = fecha.getFullYear();
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    const d = String(fecha.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  get periodoComisiones(): { desde: string, hasta: string } {
    if (this.vistaComisiones === 'dia') {
      return { desde: this.fechaComisionISO, hasta: this.fechaComisionISO };
    }
    if (this.vistaComisiones === 'semana') {
      const inicio = new Date(this.fechaComision);
      const dia = inicio.getDay();
      const diff = dia === 0 ? -6 : 1 - dia;
      inicio.setDate(inicio.getDate() + diff);
      const fin = new Date(inicio);
      fin.setDate(fin.getDate() + 6);
      return { desde: this.formatearFechaLocal(inicio), hasta: this.formatearFechaLocal(fin) };
    }
    // Mes
    const inicio = new Date(this.fechaComision.getFullYear(), this.fechaComision.getMonth(), 1);
    const fin = new Date(this.fechaComision.getFullYear(), this.fechaComision.getMonth() + 1, 0);
    return { desde: this.formatearFechaLocal(inicio), hasta: this.formatearFechaLocal(fin) };
  }

  comisionesEmpleado: any[] = [];
  cargandoComisiones = false;
  comisionesPorServicio: any[] = [];
  servicios: any[] = [];
  editandoComisionServicio: number | null = null;
  nuevaComisionServicio = 0;

  // ── AUSENCIAS ──────────────────────────────────────────────
  ausencias: any[] = [];
  mostrarFormAusencia = false;
  guardandoAusencia = false;
  nuevaAusencia: any = AusenciaVacia();

  async cargarAusencias() {
    if (!this.empleadoSeleccionado) {
      this.ausencias = [];
      return;
    }
    this.ausencias = await this.supabase.getAusencias(this.empleadoSeleccionado.id);
    this.cdr.detectChanges();
  }

  abrirFormAusencia() {
    this.nuevaAusencia = AusenciaVacia();
    this.mostrarFormAusencia = true;
    this.mostrarError('');
    this.cdr.detectChanges();
  }

  async agregarAusencia() {
    if (this.guardandoAusencia) return;
    this.mostrarError('');
    const a = this.nuevaAusencia;
    if (!a.desde) {
      this.mostrarError('❌ Elegí la fecha de inicio.');
      return;
    }
    if (a.hasta && a.hasta < a.desde) {
      this.mostrarError('❌ "Hasta" no puede ser anterior a "Desde".');
      return;
    }
    // Con una sola hora no se puede: el tope siempre es un rango.
    if (!!a.hora_inicio !== !!a.hora_fin) {
      this.mostrarError('❌ Cargá las dos horas, o ninguna para el día entero.');
      return;
    }
    if (a.hora_inicio && a.hora_fin <= a.hora_inicio) {
      this.mostrarError('❌ La hora de fin debe ser posterior a la de inicio.');
      return;
    }

    const empId = this.empleadoSeleccionado.id;
    const aLimpia = {
      empleado_id: empId,
      desde: a.desde,
      hasta: a.hasta || null,
      hora_inicio: a.hora_inicio || null,
      hora_fin: a.hora_fin || null,
      tipo: a.tipo || 'ausencia',
      motivo: (a.motivo || '').trim() || null,
    };

    this.guardandoAusencia = true;
    this.cdr.detectChanges();
    try {
      // Aviso ANTES de guardar: si pisa turnos ya agendados el usuario decide.
      // (opcion a: los turnos no se mueven, se reprograman a mano)
      const enRiesgo = await this.turnosEnRiesgo(aLimpia);
      if (enRiesgo.length && !confirm(
        `${enRiesgo.length} turno(s) van a quedar sin cobertura.\n\n` +
        `No se van a mover solos: reprogramalos a mano cuando puedas.\n\n` +
        `¿Guardar la ausencia igual?`
      )) {
        return;
      }

      await this.supabase.crearAusencia(aLimpia);
      await this.cargarAusencias();
      await this.cargarTurnosEnRiesgo();
      this.mostrarFormAusencia = false;
      this.mostrarMensaje(
        enRiesgo.length
          ? `✅ Ausencia guardada. ${enRiesgo.length} turno(s) a reprogramar.`
          : '✅ Ausencia guardada.'
      );
    } catch (e: any) {
      this.mostrarError(`❌ ${e?.message || 'No se pudo guardar'}`);
    } finally {
      this.guardandoAusencia = false;
      this.cdr.detectChanges();
    }
  }

  /** Turnos del empleado dentro del rango de la ausencia que quedan sin cobertura. */
  async turnosEnRiesgo(a: any): Promise<any[]> {
    if (!this.empleadoSeleccionado || !a?.desde) return [];
    const empId = this.empleadoSeleccionado.id;
    const turnos = await this.supabase.getTurnosPendientesDe(empId, a.desde, a.hasta || a.desde);
    return turnos.filter((t: any) =>
      turnoTocadoPorAusencia(
        [{ ...a, empleado_id: empId }],
        t.fecha,
        (t.hora_inicio || t.hora || '00:00').slice(0, 5),
        t.duracion_minutos || 45
      )
    );
  }

  // ── TURNOS EN RIESGO (Fase 5) ───────────────────────────────
  //
  // Un turno queda "en riesgo" cuando la disponibilidad actual del empleado ya no
  // lo cubre. Pasa por dos motivos distintos:
  //   · la jornada semanal no lo alcanza (no trabaja ese día, o se pasa del tope)
  //   · una ausencia cargada después lo tapa
  //
  // Decisión del usuario: los turnos NO se mueven ni se borran solos. Se listan
  // acá para que los reprograme a mano.
  //
  // Se recalcula cada vez que se guarda la jornada o se toca una ausencia, que
  // son los dos momentos en que un turno puede pasar (o dejar de estar) en riesgo.
  turnosEnRiesgoLista: any[] = [];
  cargandoRiesgo = false;

  async cargarTurnosEnRiesgo() {
    if (!this.empleadoSeleccionado) {
      this.turnosEnRiesgoLista = [];
      return;
    }
    this.cargandoRiesgo = true;
    try {
      const hoy = new Date().toISOString().slice(0, 10);
      const turnos = await this.supabase.getTurnosPendientesDe(
        this.empleadoSeleccionado.id, hoy, '2099-12-31'
      );
      const jornada = this.empleadoSeleccionado.jornada;

      this.turnosEnRiesgoLista = turnos
        .map((t: any) => {
          const hora = (t.hora_inicio || t.hora || '00:00').slice(0, 5);
          const dur = t.duracion_minutos || 45;

          const j = jornadaCubre(jornada, t.fecha, hora, dur);
          if (!j.ok) return { ...t, _motivoRiesgo: j.motivo, _tipoRiesgo: 'jornada' };

          const ausencia = turnoTocadoPorAusencia(this.ausencias, t.fecha, hora, dur);
          if (ausencia) return { ...t, _motivoRiesgo: textoAusencia(ausencia), _tipoRiesgo: 'ausencia' };

          return null;
        })
        .filter((t: any) => !!t)
        .sort((a: any, b: any) =>
          `${a.fecha}${a.hora_inicio}`.localeCompare(`${b.fecha}${b.hora_inicio}`)
        );
    } catch (e: any) {
      // No romper la pantalla de empleados si esta consulta falla.
      this.turnosEnRiesgoLista = [];
    } finally {
      this.cargandoRiesgo = false;
      this.cdr.detectChanges();
    }
  }

  async eliminarAusencia(a: any) {
    if (!confirm(`¿Eliminar la ausencia del ${a.desde}?`)) return;
    try {
      await this.supabase.eliminarAusencia(a.id);
      await this.cargarAusencias();
      // Borrar una ausencia puede SACAR turnos de riesgo. No los revalida la base
      // (decisión del usuario), pero el listado sí se recalcula.
      await this.cargarTurnosEnRiesgo();
      this.mostrarMensaje('✅ Ausencia eliminada. Los turnos no se revalidan.');
    } catch (e: any) {
      this.mostrarError(`❌ ${e?.message || 'Error'}`);
    }
    this.cdr.detectChanges();
  }

  textoAusencia(a: any): string {
    return textoAusencia(a);
  }

  async cargarComisiones() {
    if (!this.empleadoSeleccionado) {
      this.comisionesEmpleado = [];
      return;
    }
    this.cargandoComisiones = true;
    const { desde, hasta } = this.periodoComisiones;
    this.comisionesEmpleado = await this.supabase.calcularComisiones(
      this.empleadoSeleccionado.id, desde, hasta
    );
    this.cargandoComisiones = false;
    this.cdr.detectChanges();
  }

  get totalComisiones(): number {
    return this.comisionesEmpleado.reduce((sum, c) => sum + c.comision, 0);
  }

  get totalServiciosAtendidos(): number {
    return this.comisionesEmpleado.length;
  }

  async navegarPeriodo(dir: number) {
    const d = new Date(this.fechaComision);
    if (this.vistaComisiones === 'dia') {
      d.setDate(d.getDate() + dir);
    } else if (this.vistaComisiones === 'semana') {
      d.setDate(d.getDate() + dir * 7);
    } else {
      d.setMonth(d.getMonth() + dir);
    }
    this.fechaComision = d;
    await this.cargarComisiones();
    this.cdr.detectChanges();
  }

  async irAHoy() {
    this.fechaComision = new Date();
    await this.cargarComisiones();
    this.cdr.detectChanges();
  }

  formatearFecha(fecha: Date): string {
    const dia = this.diasCompletos[fecha.getDay()];
    const d = String(fecha.getDate()).padStart(2, '0');
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    return `${dia} ${d}/${m}`;
  }

  formatearPeriodo(): string {
    if (this.vistaComisiones === 'dia') {
      return this.formatearFecha(this.fechaComision);
    }
    const { desde, hasta } = this.periodoComisiones;
    if (this.vistaComisiones === 'mes') {
      // "Octubre 2026" en vez del rango de fechas
      const [y, m] = desde.split('-');
      return nombreMes(Number(m) - 1, Number(y));
    }
    const [, m1, d1] = desde.split('-');
    const [, m2, d2] = hasta.split('-');
    return `${d1}/${m1} - ${d2}/${m2}`;
  }

  formatearFechaTurno(fecha: string): string {
    if (!fecha) return '';
    const [y, m, d] = fecha.split('-');
    return `${d}/${m}/${y}`;
  }

  formatearHora(hora: string): string {
    return hora?.slice(0, 5) || '';
  }

  mostrarMensaje(msg: string) {
    this.mensaje = msg;
    this.mensajeError = '';
    this.cdr.detectChanges();
    setTimeout(() => { this.mensaje = ''; this.cdr.detectChanges(); }, 3000);
  }

  mostrarError(msg: string) {
    this.mensajeError = msg;
    this.mensaje = '';
    this.cdr.detectChanges();
    setTimeout(() => { this.mensajeError = ''; this.cdr.detectChanges(); }, 3000);
  }
}
