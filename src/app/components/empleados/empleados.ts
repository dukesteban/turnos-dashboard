import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { skip } from 'rxjs';
import { SupabaseService } from '../../services/supabase';
import { AuthService } from '../../services/auth';
import { problemaTelefono } from '../../utils/telefono';
import {
  normalizarJornada, DIAS, SlotJornada, fechaConAnio,
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
  // ── Acordeones del detalle ──
  // El detalle tiene 5 bloques y juntos ocupan varias pantallas. Cada uno es un
  // acordeón: cerrado salvo "Datos", que arranca abierto (mismo criterio que
  // Configuración, donde `acordeonDatos = true`).
  //
  // `Inactivar empleado` NO entra en un acordeón a propósito: es una acción
  // destructiva y tiene que quedar a la vista, no escondida detrás de un click.
  //
  // El body del acordeón usa `display`, no `*ngIf`, así que colapsar NO pierde
  // la edición a medio hacer (media jornada sin guardar, formulario de ausencia
  // abierto). Si alguna vez se cambia a `*ngIf`, eso se pierde.
  acordeonDatos = true;
  acordeonJornada = false;
  acordeonAusencias = false;
  acordeonRiesgo = false;
  acordeonComisiones = false;
  acordeonAcceso = false;

  // ── Rol de acceso ──
  // Solo lo ven el admin y el secretario (la política de RLS de `usuarios` no le
  // deja leer la tabla al empleado, así que `roles` llega vacío y el bloque se
  // oculta). El rol no se edita desde acá: se da de alta el acceso, que es lo que
  // hace falta, y cambiar un rol después sigue siendo cosa de Configuración.
  roles: Record<number, string> = {};
  /** El nombre de usuario con el que entra cada empleado (usuarios.usuario). */
  usuariosDeAcceso: Record<number, string> = {};
  rolesCargados = false;
  modalAcceso = false;
  accesoUsuario = '';
  accesoClave = '';
  accesoRol = 'empleado';
  accesoError = '';
  accesoGuardando = false;
  guardandoAtiende = false;

  private readonly ROLES = [
    { valor: 'admin', etiqueta: 'Administrador' },
    { valor: 'secretario', etiqueta: 'Secretario' },
    { valor: 'empleado', etiqueta: 'Empleado' },
  ];

  get rolesDisponibles(): Array<{ valor: string; etiqueta: string }> {
    return this.ROLES;
  }

  /** "admin" -> "Admin", para el chipito de la lista. */
  etiquetaRol(rol: string): string {
    const r = this.ROLES.find((x: any) => x.valor === rol);
    return r ? r.etiqueta : rol;
  }

  /**
   * El bloque de rol solo se muestra al admin y al secretario.
   *
   * No alcanza con que la RLS no le devuelva nada al empleado: si la pantalla
   * mostrara el bloque igual, el empleado vería que hay un rol y que no tiene
   * acceso. Se oculta entero.
   */
  get puedeVerRoles(): boolean {
    return this.rolActual === 'admin' || this.rolActual === 'secretario';
  }

  get nombreRol(): string {
    const e: any = this.empleadoSeleccionado;
    if (!e) return '';
    const r = this.roles[e.id];
    if (!r) return 'Sin acceso a la app';
    return this.ROLES.find(x => x.valor === r)?.etiqueta ?? r;
  }

  get tieneAcceso(): boolean {
    const e: any = this.empleadoSeleccionado;
    return !!e && !!this.roles[e.id];
  }

  /** El usuario con el que entra este empleado, o vacio si no tiene acceso. */
  get usuarioAcceso(): string {
    const e: any = this.empleadoSeleccionado;
    return e ? (this.usuariosDeAcceso[e.id] ?? '') : '';
  }

  /** Estado de acordeón limpio: solo "Datos" abierto. Se llama al seleccionar. */
  private abrirSoloDatos() {
    this.acordeonDatos = true;
    this.acordeonJornada = false;
    this.acordeonAusencias = false;
    this.acordeonRiesgo = false;
    this.acordeonComisiones = false;
    this.acordeonAcceso = false;
  }

  empleados: any[] = [];
  empleadoSeleccionado: any = null;
  mensaje = '';
  mensajeError = '';
  busqueda = '';

  // Formulario
  nuevoNombre = '';
  nuevoTelefono = '';
  nuevoCuit = '';
  nuevaDireccion = '';
  nuevaComision = 10;
  /** Jornada por defecto: L-V. Un dia con horas vacias = jornada completa. */
  jornadaDefault: SlotJornada[] = jornadaVaciaPorDefecto();
  jornadaNueva: SlotJornada[] = jornadaVaciaPorDefecto();
  mostrarModalNuevoEmpleado = false;
  guardandoNuevoEmpleado = false;
  errorNuevoEmpleado = '';

  diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  diasCompletos = DIAS;

  /** Rol del que está usando la app, para decidir si el bloque de roles se muestra. */
  rolActual = 'empleado';

  constructor(
    private supabase: SupabaseService,
    private auth: AuthService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
  ) {}

  async ngOnInit() {
    // El rol sale del JWT, no de la base: es lo mismo que la RLS mira.
    this.rolActual = this.auth.getRol();
    // Independientes: en serie eran dos vueltas a la base antes de ver la lista.
    await Promise.all([this.cargarEmpleados(), this.cargarRoles()]);
    // `?empleado=ID` viene del popup del turno: abre directo la ficha.
    this.route.queryParamMap.pipe(skip(1)).subscribe((params) => {
      const id = Number(params.get('empleado'));
      if (id) this.abrirEmpleadoPorId(id);
    });
    // Primer valor (snapshot) para la carga inicial.
    const idInicial = Number(this.route.snapshot.queryParamMap.get('empleado'));
    if (idInicial) await this.abrirEmpleadoPorId(idInicial);
    this.cdr.detectChanges();
  }

  private async abrirEmpleadoPorId(id: number) {
    const e = this.empleados.find((x: any) => x.id === id);
    if (e) await this.seleccionarEmpleado(e);
  }

  /**
   * Los roles de acceso. Si el usuario no tiene permiso (es empleado), el servicio
   * devuelve un mapa vacío en vez de tirar: acá no hay nada que mostrar y la
   * pantalla sigue funcionando.
   */
  private async cargarRoles() {
    const accesos = await this.supabase.getAccesosEmpleados();
    this.roles = {};
    this.usuariosDeAcceso = {};
    for (const [id, acceso] of Object.entries(accesos)) {
      this.roles[Number(id)] = acceso.rol;
      this.usuariosDeAcceso[Number(id)] = acceso.usuario;
    }
    this.rolesCargados = true;
    this.cdr.detectChanges();
  }

  // ── Dar acceso ──
  abrirModalAcceso() {
    const e: any = this.empleadoSeleccionado;
    this.accesoUsuario = this.nombreComoUsuario(e?.nombre);
    this.accesoClave = '';
    this.accesoRol = 'empleado';
    this.accesoError = '';
    this.modalAcceso = true;
    this.cdr.detectChanges();
  }

  cerrarModalAcceso() {
    this.modalAcceso = false;
    this.cdr.detectChanges();
  }

  async guardarAcceso() {
    const e: any = this.empleadoSeleccionado;
    if (!e) return;
    if (!this.accesoUsuario.trim()) {
      this.accesoError = '❌ Ingresá un nombre de usuario.';
      this.cdr.detectChanges();
      return;
    }
    // Sin clave no se puede crear: el usuario no tendria como entrar nunca.
    if (this.accesoClave.trim().length < 6) {
      this.accesoError = '❌ La clave necesita al menos 6 caracteres.';
      this.cdr.detectChanges();
      return;
    }

    this.accesoGuardando = true;
    this.accesoError = '';
    try {
      await this.supabase.crearUsuario({
        usuario: this.accesoUsuario.trim(),
        clave: this.accesoClave.trim(),
        rol: this.accesoRol,
        empleado_id: e.id,
      });
      await this.cargarRoles();
      this.modalAcceso = false;
      this.mostrarMensaje(`✅ Acceso creado para ${e.nombre}.`);
    } catch (err: any) {
      this.accesoError = `❌ ${err?.message || 'No se pudo crear el acceso'}`;
    }
    this.accesoGuardando = false;
    this.cdr.detectChanges();
  }

  /** "Esteban Aguero" -> "esteban.aguero": un usuario sin espacios ni acentos. */
  private nombreComoUsuario(nombre: string): string {
    return (nombre ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '.')
      .replace(/^\.+|\.+$/g, '');
  }

  async cargarEmpleados() {
    // Trae TODOS, inactivos incluidos: la lista los muestra con su badge para
    // que se vea quien esta dado de baja. Los selectores de turnos y la agenda
    // usan getEmpleados() (solo activos) y no se ven afectados.
    const data = await this.supabase.getTodosEmpleados();
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
    this.nuevoCuit = '';
    this.nuevaDireccion = '';
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
        cuit_cuil: this.nuevoCuit.replace(/[\s-]/g, '').trim() || null,
        direccion: this.nuevaDireccion.trim() || null,
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
    // La foto de nombre y teléfono, para que "Cancelar" vuelva a donde estabas
    // en vez de dejar lo que se escribió a medias. Se toma acá, al seleccionar,
    // y no de la lista: si el guardado ya actualizó la fila, leer la lista
    // después devolvería lo recien guardado y "Cancelar" no cancelaría nada.
    const datos = {
      nombre: empleado.nombre || '',
      telefono: empleado.telefono || '',
    };
    this.empleadoSeleccionado = {
      ...empleado,
      ...datos,
      jornada,
      _jornadaOrig: JSON.parse(JSON.stringify(jornada)),
      _datosOrig: datos,
      editando: false,
      // Los flags de la edicion por campo que ya no existen. Se limpian para que
      // un empleado que venia de la version vieja no quede medio editado.
      editandoTelefono: false,
    };
    // Cada empleado arranca con solo "Datos" abierto. Sin esto, el empleado
    // anterior deja los cinco acordeones como los dejó y el que viene queda con
    // un panel de 4 pantallas abierto sin haberlo pedido.
    this.abrirSoloDatos();
    // El "total a pagar del período" se mudó a Caja → Empleados. Acá ya no se
    // llama a `calcularComisiones()`, que hacía una ida a la base POR CADA
    // empleado que se abría, para alimentar un bloque que ya no existe en esta
    // pantalla.
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

  /**
   * Poner nombre y teléfono en edición.
   *
   * Un solo flag para los dos campos. Antes había dos (`editando` y
   * `editandoTelefono`) con un lápiz por campo: en una columna de dos campos
   * parecían cuatro acciones y el que de verdad se editaba a menudo quedaba
   * sin destino claro.
   */
  editarDatos() {
    if (!this.empleadoSeleccionado) return;
    this.empleadoSeleccionado.editando = true;
    this.cdr.detectChanges();
  }

  /**
   * Cancelar: vuelve a los valores con los que se abrió el panel.
   *
   * Restaura `_datosOrig` en vez de solo cerrar el modo edición. Si solo se
   * cerrara, al volver a apretar "Editar" se vería lo que se escribió la vez
   * anterior sin saber que nunca se guardó.
   */
  cancelarEdicionDatos() {
    const emp = this.empleadoSeleccionado;
    if (!emp) return;
    Object.assign(emp, emp._datosOrig);
    emp.editando = false;
    this.cdr.detectChanges();
  }

  /**
   * Guardar nombre y teléfono en UNA llamada.
   *
   * Con un botón único, mandar los dos campos juntos es lo que espera la gente:
   * o se guarda la ficha o no se guarda. Antes eran dos updates (uno por campo)
   * y con nombre vacío se mandaba `""` a una columna NOT NULL.
   */
  async guardarDatos() {
    const emp = this.empleadoSeleccionado;
    if (!emp || emp.guardando || !emp.editando) return;

    const nombre = (emp.nombre ?? '').trim();
    if (!nombre) {
      this.mostrarError('❌ El nombre es obligatorio.');
      this.cdr.detectChanges();
      return;
    }

    emp.guardando = true;
    this.cdr.detectChanges();
    try {
      // CUIT/CUIL: solo números, sin guiones ni espacios. Si no se limpió, se guarda
      // tal cual vino y después es un quilombo compararlo con el de otro lado.
      const cuit = (emp.cuit_cuil ?? '').replace(/[\s-]/g, '').trim();

      const datos = {
        nombre,
        // Vacío -> null, no cadena vacía: en la base la columna es nullable y
        // "" es un valor distinto de "no cargado".
        telefono: (emp.telefono ?? '').trim() || null,
        cuit_cuil: cuit || null,
        direccion: (emp.direccion ?? '').trim() || null,
      };
      await this.supabase.updateEmpleado(emp.id, datos);

      const idx = this.empleados.findIndex(e => e.id === emp.id);
      if (idx >= 0) {
        this.empleados[idx].nombre = datos.nombre;
        this.empleados[idx].telefono = datos.telefono;
        this.empleados[idx].cuit_cuil = datos.cuit_cuil;
        this.empleados[idx].direccion = datos.direccion;
      }
      emp.nombre = datos.nombre;
      emp.telefono = datos.telefono || '';
      emp.cuit_cuil = datos.cuit_cuil || '';
      emp.direccion = datos.direccion || '';
      emp._datosOrig = { nombre: emp.nombre, telefono: emp.telefono };
      emp.editando = false;
      this.mostrarMensaje('✅ Datos actualizados.');
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

  /**
   * Prende o apaga si este empleado toma turnos.
   *
   * No se borra ni se inactiva: sigue existiendo para Caja y para los turnos
   * viejos. Solo deja de ofrecerse en Agenda, en los selectores de turno y en
   * el bot. Se guarda al instante porque es un switch, no un formulario.
   */
  async guardarAtiende(atiende: boolean) {
    const emp = this.empleadoSeleccionado;
    if (!emp || this.guardandoAtiende) return;
    const anterior = emp.atiende !== false;
    if (anterior === atiende) return;

    emp.atiende = atiende;
    const fila = this.empleados.find(e => e.id === emp.id);
    if (fila) fila.atiende = atiende;

    this.guardandoAtiende = true;
    this.cdr.detectChanges();
    try {
      await this.supabase.updateEmpleado(emp.id, { atiende });
      this.mostrarMensaje(atiende ? '✅ Ahora atiende turnos.' : '✅ Ya no atiende turnos.');
    } catch (e) {
      emp.atiende = anterior;
      if (fila) fila.atiende = anterior;
      this.mostrarError('❌ No se pudo guardar.');
    }
    this.guardandoAtiende = false;
    this.cdr.detectChanges();
  }

  // COMISIONES
  // Lo que queda aca es SOLO el detalle por servicio: los porcentajes que tiene
  // este empleado en cada tipo de lavado, que son parte de la ficha (se editan
  // aca, con el plumin).
  //
  // El "total a pagar del periodo", con el desglose turno por turno, se mudo a
  // Caja -> Empleados. Por eso se sacaron `periodoComisiones`, `cargarComisiones`,
  // `totalComisiones` y los getters de periodo: no los muestra nadie aca, y
  // `cargarComisiones` pegaba a la base una vez por cada empleado que se abria.
  //
  // `formatearFechaLocal` se conserva: lo usa la validacion de ausencias.
  formatearFechaLocal(fecha: Date): string {
    const y = fecha.getFullYear();
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    const d = String(fecha.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
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
          `${b.fecha}${b.hora_inicio}`.localeCompare(`${a.fecha}${a.hora_inicio}`)
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
    if (!confirm(`¿Eliminar la ausencia del ${fechaConAnio(a.desde)}?`)) return;
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