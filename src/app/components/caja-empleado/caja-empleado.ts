import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth';
import { SupabaseService } from '../../services/supabase';
import { nombreMes, fechaDesdeISO } from '../../utils/fechas';

/**
 * "Mi caja": lo mismo que la pestaña Empleados de Caja, pero SOLO con los datos
 * del empleado que está mirando.
 *
 * POR QUÉ UN COMPONENTE APARTE Y NO UN `*ngIf` EN CAJA
 *
 * Caja es la pantalla del local: tres pestañas, un selector de empleado, pagos,
 * compras y proveedores. Meter un modo "solo lo mío" adentro obligaba a que cada
 * tabla, cada botón y cada consulta preguntaran el rol. Acá la pantalla nace sin
 * selector y sin escritura, así que no hay forma de que un filtro mal puesto
 * termine mostrando los datos de otro.
 *
 * SÍ ES DE SOLO LECTURA, y no por una decisión de diseño: el empleado no puede
 * escribir en `pagos_empleado` (RLS). Mostrar los botones para que la base los
 * rechace sería una pantalla que miente.
 */
@Component({
  selector: 'app-caja-empleado',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './caja-empleado.html',
  styleUrls: ['./caja-empleado.scss'],
})
export class CajaEmpleadoComponent implements OnInit {
  vista: 'dia' | 'semana' | 'mes' = 'mes';
  fechaActual = new Date();
  cargando = false;
  /** true solo mientras navega (cambia día/semana/mes), no en la carga inicial. */
  cargandoNavegacion = false;

  /** Turnos ATENDIDOS del período, ya filtrados al empleado. */
  turnos: any[] = [];
  /** Pagos que le hicieron en el período, ya filtrados al empleado. */
  pagos: any[] = [];
  /** Porcentajes POR SERVICIO, que pisan al general del empleado. */
  comisionesServicio: any[] = [];
  /** La ficha del empleado logueado (para el nombre y el porcentaje general). */
  miEmpleado: any = null;

  // Arrancan CERRADOS, como en Caja: primero se leen los tres montos, y el
  // detalle se abre solo cuando se va a buscar.
  acordeonDetalle = false;
  acordeonPagos = false;

  constructor(
    private supabase: SupabaseService,
    private cdr: ChangeDetectorRef,
    private auth: AuthService
  ) {}

  get miId(): number | null {
    return this.auth.getEmpleadoId();
  }

  get nombreEmpleado(): string {
    return this.miEmpleado?.nombre || 'Mi cuenta';
  }

  async ngOnInit() {
    await this.cargarDatos();
  }

  async cargarDatos() {
    const miId = this.miId;
    if (miId === null) {
      // Sin `empleado_id` no hay nada que mostrar. La guard ya impide llegar
      // acá, pero si alguien escribe la URL a mano, una pantalla vacía es mejor
      // que una que muestre los datos de todos.
      this.turnos = [];
      this.pagos = [];
      this.cargando = false;
      this.cargandoNavegacion = false;
      this.cdr.detectChanges();
      return;
    }

    this.cargando = true;
    const { desde, hasta } = this.getRango();
    // Las cuatro consultas van juntas: son independientes y en serie cada una
    // cuesta una vuelta completa a la base antes de pintar la pantalla.
    const [turnos, pagos, comisiones, empleados] = await Promise.all([
      // `getGanancias` ya filtra `estado = 'atendido'`: acá solo queda quedarse
      // con los del empleado. Un turno pendiente o cancelado no genera comisión.
      this.supabase.getGanancias(desde, hasta),
      this.supabase.getPagosEmpleado(desde, hasta),
      this.supabase.getComisionesEmpleado(miId),
      // `getTodosEmpleados` y no `getEmpleados`: si el empleado fue dado de baja
      // sigue pudiendo entrar y ver lo que ya trabajó, y su porcentaje general
      // tiene que seguir resolviéndose.
      this.supabase.getTodosEmpleados(),
    ]);

    this.turnos = (turnos || []).filter((t: any) => t.empleado_id === miId);
    this.pagos = (pagos || []).filter((p: any) => p.empleado_id === miId);
    this.comisionesServicio = comisiones || [];
    this.miEmpleado = (empleados || []).find((e: any) => e.id === miId) || null;
    this.cargando = false;
    this.cargandoNavegacion = false;
    this.cdr.detectChanges();
  }

  // ── LOS TRES MONTOS ─────────────────────────────────────────

  /**
   * Filas del acordeón "Turnos atendidos".
   *
   * El orden por defecto es el MÁS NUEVO ARRIBA, igual que el resto de las
   * tablas de la app. La comisión se calcula con el porcentaje del SERVICIO
   * REALMENTE hecho (pudo pedir completo y hacerse simple), que es sobre el que
   * se cobra.
   */
  get comisionesDetalle(): {
    fecha: string;
    hora: string;
    servicio: string;
    precio: number;
    comision: number;
  }[] {
    return this.turnos
      .map((t: any) => {
        const precio = Number(t.precio_final || t.precio) || 0;
        return {
          fecha: t.fecha,
          hora: (t.hora_inicio || t.hora || '').slice(0, 5),
          servicio: t.servicio_nombre_final || t.servicio_nombre || 'Sin especificar',
          precio,
          comision: (precio * this.porcentajeComision(t)) / 100,
        };
      })
      .sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora));
  }

  get totalComisiones(): number {
    return this.comisionesDetalle.reduce((sum, c) => sum + c.comision, 0);
  }

  get totalPagado(): number {
    return this.pagos.reduce((sum, p) => sum + (Number(p.monto) || 0), 0);
  }

  /**
   * Lo que todavía le falta cobrar. Si le pagaron de más (un adelanto) queda en
   * CERO: en esta pantalla no hay un número negativo ni un "me deben al revés".
   *
   * En la pantalla NUNCA se muestra el signo: el texto de abajo ("A cobrar" /
   * "Al día") dice de qué lado está. Un `-$5.000` obliga a recordar quién le
   * debe a quién.
   */
  get saldoPendiente(): number {
    return Math.max(this.totalComisiones - this.totalPagado, 0);
  }

  get textoSaldo(): string {
    return this.totalComisiones - this.totalPagado > 0 ? 'A cobrar' : 'Al día';
  }

  /** Los pagos, del más nuevo al más viejo (regla de todas las tablas). */
  get pagosOrdenados(): any[] {
    return [...this.pagos].sort(
      (a, b) =>
        String(b.fecha || '').localeCompare(String(a.fecha || '')) ||
        (Number(b.id) || 0) - (Number(a.id) || 0)
    );
  }

  /**
   * Porcentaje de este turno: el del servicio si hay uno cargado, y si no el
   * general del empleado.
   *
   * Mismo orden que `CajaComponent.porcentajeComision` y que
   * `getComisionesPeriodo`: el específico PISA al general.
   */
  private porcentajeComision(turno: any): number {
    const porServicio = this.comisionesServicio.find(
      (c: any) =>
        c.empleado_id === turno.empleado_id &&
        c.servicio_id !== null &&
        c.servicio_id === (turno.servicio_id_final ?? turno.servicio_id)
    );
    if (porServicio) return Number(porServicio.porcentaje) || 0;

    return Number(this.miEmpleado?.comision_porcentaje) || 0;
  }

  // ── PERÍODO Y NAVEGACIÓN ────────────────────────────────────
  //
  // Se copia el patrón de Caja a propósito: los mismos botones, los mismos
  // títulos y la misma aritmética de fechas. Si mañana cambia el criterio de
  // "semana", tiene que cambiar en un solo lugar; por eso las dos pantallas
  // comparten formato, aunque no el archivo.

  getRango(): { desde: string; hasta: string } {
    const formatLocal = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    if (this.vista === 'dia') {
      const d = formatLocal(this.fechaActual);
      return { desde: d, hasta: d };
    }

    if (this.vista === 'semana') {
      // Lunes a domingo. El `getDay()` de un domingo es 0: sin el caso especial,
      // la semana arrancaría en el lunes siguiente y el domingo quedaría afuera.
      const lunes = new Date(this.fechaActual);
      const dow = lunes.getDay();
      lunes.setDate(lunes.getDate() - (dow === 0 ? 6 : dow - 1));
      const domingo = new Date(lunes);
      domingo.setDate(lunes.getDate() + 6);
      return { desde: formatLocal(lunes), hasta: formatLocal(domingo) };
    }

    const y = this.fechaActual.getFullYear();
    const m = this.fechaActual.getMonth();
    return {
      desde: formatLocal(new Date(y, m, 1)),
      hasta: formatLocal(new Date(y, m + 1, 0)),
    };
  }

  navegar(dir: number) {
    if (this.vista === 'dia') {
      const d = new Date(this.fechaActual);
      d.setDate(d.getDate() + dir);
      this.fechaActual = d;
    } else if (this.vista === 'semana') {
      const d = new Date(this.fechaActual);
      d.setDate(d.getDate() + dir * 7);
      this.fechaActual = d;
    } else {
      // `setMonth` con overflow salta de mes: 31 de enero + 1 mes es "31 de
      // febrero", que Date normaliza a 3 de marzo. Se clampea al último día del
      // mes destino.
      const y = this.fechaActual.getFullYear();
      const m = this.fechaActual.getMonth() + dir;
      const ultimoDestino = new Date(y, m + 1, 0).getDate();
      const dia = Math.min(this.fechaActual.getDate(), ultimoDestino);
      this.fechaActual = new Date(y, m, dia);
    }
    this.cargandoNavegacion = true;
    this.cdr.detectChanges();
    this.cargarDatos();
  }

  irHoy() {
    this.fechaActual = new Date();
    this.cargandoNavegacion = true;
    this.cdr.detectChanges();
    this.cargarDatos();
  }

  irAFecha(iso: string) {
    const d = fechaDesdeISO(iso);
    if (!d) return;
    this.fechaActual = d;
    this.cargandoNavegacion = true;
    this.cdr.detectChanges();
    this.cargarDatos();
  }

  cambiarVista(v: 'dia' | 'semana' | 'mes') {
    this.vista = v;
    this.fechaActual = new Date();
    this.cargandoNavegacion = true;
    this.cdr.detectChanges();
    this.cargarDatos();
  }

  get tituloFecha(): string {
    if (this.vista === 'dia') {
      const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
      const d = String(this.fechaActual.getDate()).padStart(2, '0');
      const m = String(this.fechaActual.getMonth() + 1).padStart(2, '0');
      return `${dias[this.fechaActual.getDay()]} ${d}/${m}`;
    }
    if (this.vista === 'semana') {
      const { desde, hasta } = this.getRango();
      const [, m1, d1] = desde.split('-');
      const [, m2, d2] = hasta.split('-');
      return `${d1}/${m1} - ${d2}/${m2}`;
    }
    return nombreMes(this.fechaActual.getMonth(), this.fechaActual.getFullYear());
  }

  /** 'AAAA-MM-DD' local (no UTC: `toISOString` corre el día en timezone negativo). */
  hoyISO(): string {
    return new Date().toLocaleDateString('en-CA');
  }

  /** Fecha corta DD/MM, como el resto de las tablas de la app. */
  formatearFechaCorta(iso: string): string {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso).trim());
    if (!m) return iso;
    return `${m[3]}/${m[2]}`;
  }
}
