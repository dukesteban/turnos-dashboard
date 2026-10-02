import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';
import { nombreMes } from '../../utils/fechas';

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
  diasTrabaja: boolean[] = [false, true, true, true, true, true, false]; // Dom-Lun-Mar-Mié-Jue-Vie-Sáb
  mostrarModalNuevoEmpleado = false;
  guardandoNuevoEmpleado = false;
  errorNuevoEmpleado = '';

  diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  diasCompletos = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarEmpleados();
    this.cdr.detectChanges();
  }

  async cargarEmpleados() {
    const data = await this.supabase.getEmpleados();
    // Normalizar dias_trabaja (pueden venir como strings de Supabase)
    this.empleados = data.map((e: any) => ({
      ...e,
      dias_trabaja: e.dias_trabaja 
        ? e.dias_trabaja.map((d: any) => d === true || d === 'true')
        : [false, true, true, true, true, true, false]
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
    this.diasTrabaja = [false, true, true, true, true, true, false];
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
    try {
      const empleado = await this.supabase.crearEmpleado({
        nombre: this.nuevoNombre.trim(),
        telefono: this.nuevoTelefono.trim() || null,
        comision_porcentaje: this.nuevaComision,
        dias_trabaja: this.diasTrabaja
      });
      this.empleados.push(empleado);
      this.nuevoNombre = '';
      this.nuevoTelefono = '';
      this.nuevaComision = 10;
      this.diasTrabaja = [false, true, true, true, true, true, false];
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
    this.empleadoSeleccionado = { ...empleado, editando: false };
    await this.cargarComisiones();
    await this.cargarComisionesPorServicio();
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

  async guardarDias() {
    if (!this.empleadoSeleccionado || this.empleadoSeleccionado.guardando) return;
    const emp = this.empleadoSeleccionado;
    emp.guardando = true;
    this.cdr.detectChanges();
    try {
      await this.supabase.updateEmpleado(emp.id, { dias_trabaja: emp.dias_trabaja });
      const idx = this.empleados.findIndex(e => e.id === emp.id);
      if (idx >= 0) this.empleados[idx].dias_trabaja = [...emp.dias_trabaja];
      emp.editandoDias = false;
      this.mostrarMensaje('✅ Días actualizados.');
    } catch (e) {
      this.mostrarError('❌ Error al actualizar.');
    } finally {
      emp.guardando = false;
      this.cdr.detectChanges();
    }
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
