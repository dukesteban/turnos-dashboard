import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MonedaDirective } from '../../utils/moneda.directive';
import { AuthService } from '../../services/auth';
import { SupabaseService } from '../../services/supabase';
import { jornadaCubre, turnoTocadoPorAusencia, textoAusencia, normalizarJornada, debeMostrarColumna, fechaDesdeISO } from '../../utils/fechas';
import { soloLosTurnosDe, soloLasColumnasDe, confirmarVolverAPendiente } from '../../utils/turnos';

const PX_POR_MINUTO = 1.2;
/** Alto del header de columnas (vista dia). Los turnos se corren esta cantidad. */
const H_HEADER_COLUMNAS = 44;
/** Alto del header de columnas compactado (vista semana). */
const H_HEADER_MINI = 20;
/** Gutter horizontal entre columnas: debe coincidir con el margen del header. */
const GAP_COLUMNA = 3;

/**
 * Ancho de una columna de empleado, segun cuanto pantalla hay.
 *
 * En MONITOR una columna de 240px entra cómoda y se lee el nombre del empleado
 * de una. En un CELU de 360px entran una columna y un poco más, así que con 4
 * empleados había que scrollear tres veces solo para ver quién atiende, y cada
 * toque de scroll horizontal era chances de perder de vista la columna de horas
 * que se acababa de agregar.
 *
 * Por eso el celu usa columnas más angostas: entran ~2 y media, que es la
 * cantidad desde la que se lee "este turno es de ESTE" sin scrollear.
 *
 * Los numeros van en TS y no en un `@media` de CSS porque el ancho NO es
 * decorativo: `posicionTurno` reparte los bloques como `pct%` y `anchoDeDia`
 * suma estos numeros, asi que el layout entero sale de acá. Si se changea el
 * ancho desde CSS, el TS sigue calculando con el viejo y los bloques se salen
 * de su columna.
 */
const ANCHO_COL_DIA = 240;
const ANCHO_COL_SEMANA = 92;
const ANCHO_COL_DIA_CHICA = 150;
const ANCHO_COL_SEMANA_CHICA = 74;

/**
 * Ancho de la columna de horas, la de la izquierda que queda pegada al scrollear.
 *
 * Tiene que coincidir con el `width` de `.col-horas-header` y `.col-horas-abs` del
 * SCSS (40px), y NO es un detalle: `anchoGrillaSemana` lo suma para saber hasta
 * dónde llega la grilla, y si el TS dice 40 y el CSS dice otro, el encabezado se
 * queda corto por esa diferencia y vuelve el bug del fondo que solo tapa lunes.
 */
const ANCHO_COL_HORAS = 40;

/**
 * Corte de "pantalla chica". 700px y no 640 porque es el breakpoint que ya usa
 * el resto de la app, y queda por debajo de una tablet en vertical, que es
 * justo el caso donde 240px de columna ya molestan.
 */
const ANCHO_MAX_CHICA = 700;

@Component({
  selector: 'app-agenda',
  standalone: true,
  imports: [CommonModule, FormsModule, MonedaDirective],
  templateUrl: './agenda.html',
  styleUrls: ['./agenda.scss']
})
export class AgendaComponent implements OnInit, OnDestroy {
  private subscription: any;

  vista: 'dia' | 'semana' = 'dia';
  fechaActual: Date = new Date();
  turnos: any[] = [];

  /**
   * Ancho de la ventana, para decidir el ancho de columna.
   *
   * Vive acá y no en un `@media` de CSS porque el ancho de columna no es
   * decorativo: de él salen `posicionTurno` (los `pct%` de cada bloque) y
   * `anchoDeDia`. Si el corte se hiciera en CSS, el TS calcularía el layout con
   * el ancho viejo y los bloques se saldrían de su columna.
   *
   * Se escucha el `resize` y no se calcula una sola vez al inicio porque en un
   * monitor se puede ir de la pantalla grande al celu con la ventana del navegador
   * (o en una tablet girándola), y sin listener la grilla se queda con el ancho
   * de la pantalla en la que arrancó.
   */
  private anchoVentana: number = typeof window !== 'undefined' ? window.innerWidth : 1200;

  /** ¿Entra en la categoría de pantalla chica? Ver `ANCHO_MAX_CHICA`. */
  get pantallaChica(): boolean {
    return this.anchoVentana <= ANCHO_MAX_CHICA;
  }

  // Puestos de trabajo (columnas de la agenda)
  // RETIRADO: las columnas de la agenda ahora son una por EMPLEADO.
  // Ver columnasPara(fecha) mas abajo.
  ausencias: any[] = [];
  /** Telefono ACTUAL por cliente. El del turno es un snapshot y puede estar viejo. */
  telefonosPorCliente: Record<number, string> = {};

  /** Telefono vigente del cliente de un turno. */
  telefonoDe(turno: any): string | null {
    if (!turno) return null;
    const actual = turno.cliente_id ? this.telefonosPorCliente[turno.cliente_id] : null;
    return actual || turno.cliente_telefono || null;
  }
  /** Cache de jornadas por empleado para no consultarla por celda de la agenda. */
  jornadas: Record<number, any> = {};
  /**
   * Columnas ya resueltas por fecha. La vista Dia la pide una vez, la Semana
   * siete; sin cache se recalculan en cada change detection.
   */
  private cacheColumnas: Record<string, any[]> = {};

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
  /** Solo los que pueden atender en la fecha/hora del form de reprogramar. */
  empleadosReprogramar: any[] = [];
  /** El empleado elegido NO puede trabajar ese día (se muestra con aviso). */
  empleadoReprogramarNoPuede = false;
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
  /** El envío automático no salió: se muestra y se ofrece el link a mano. */
  errorMensaje = '';
  linkWhatsapp = '';
  nombreNegocio = localStorage.getItem('nombre_negocio') || '';
  // El teléfono de emergencia va al pie de los mensajes de cancelación y
  // reprogramación. Se cachea en localStorage igual que el nombre del negocio
  // (lo carga app.ts al iniciar) para no pedir la config en cada envío.
  telefonoEmergencia = localStorage.getItem('telefono_emergencia') || '';
  mostrarPopupPostergacion = false;
  motivoPostergacion = '';
  enviandoMensajePostergacion = false;
  private subHorarios: any;
  _nuevaFechaPostergacion = '';
  _nuevaHoraPostergacion = '';
  _nuevoServicioPostergacion = '';
  atendidoEmpleadoId: number | null = null;

  constructor(
    private supabase: SupabaseService,
    private cdr: ChangeDetectorRef,
    private auth: AuthService,
    private router: Router
  ) {}

  async ngOnInit() {
    window.addEventListener('resize', this.alRedimensionar);

    // Las listas independientes arrancan YA, en paralelo, y mientras viajan se
    // piden horarios y turnos. Antes eran nueve `await` uno detras de otro: cada
    // uno costaba una vuelta completa a la base (~400 ms) y la pantalla tardaba
    // varios segundos en algo que se puede pedir junto.
    const datos = Promise.all([
      this.supabase.getMetodosPago(),
      this.supabase.getEmpleados(),
      this.supabase.getAusencias(),
      this.supabase.getTelefonosPorCliente(),
      this.supabase.getDiasCerrados(),
      this.supabase.getComisiones(),
    ]);

    // En serie a proposito: `cargarHorarios` fija `horaInicio/horaFin` y
    // `cargarTurnos` los vuelve a ajustar con los turnos que trae.
    await this.cargarHorarios();
    await this.cargarTurnos();

    const [metodosPago, empleados, ausencias, telefonos, diasCerrados, comisiones] = await datos;
    this.metodosPago = metodosPago;
    this.empleados = empleados;
    this.ausencias = ausencias;
    this.telefonosPorCliente = telefonos;
    this.diasCerrados = diasCerrados;
    this.comisionesPorServicio = comisiones;
    // Cache de jornadas: la usa turnoEnRiesgo() por cada bloque de la grilla.
    this.jornadas = {};
    for (const e of this.empleados as any[]) {
      this.jornadas[e.id] = normalizarJornada(e.jornada);
    }
    // IMPORTANTE: el getter columnasAgenda se evalua en el PRIMER render, cuando
    // this.empleados todavia esta vacio, y cachea un [] para la fecha de hoy.
    // Si no se limpia aca, la grilla queda sin columnas para siempre aunque los
    // empleados ya hayan llegado. El build no lo ve y los tests tampoco: el
    // getter depende del estado del componente, no es una funcion pura.
    // ROTO A PROPOSITO (se revierte enseguida): sin esta linea, la cache queda
    // con el [] que se calculo antes de que llegaran los empleados.
    // IMPORTANTE: sin esta linea la grilla puede quedar sin columnas para
    // siempre. El getter columnasAgenda se evalua en un render temprano, cuando
    // this.empleados todavia esta vacio, y cachea un [] que nadie invalida
    // despues. `cargarTurnos` tambien limpia, pero corre ANTES de que lleguen
    // los empleados: sin esta segunda limpieza el [] sobrevive.
    //
    // Costo de equivocarse: build, typecheck y los tests de utils pasan igual.
    // Solo se ve mirando la app andando. Por eso hay un test de componente.
    this.limpiarCacheColumnas();
    this.subscription = this.supabase.suscribirTurnos(() => {
      // Forzado: aunque la semana ya este cargada, el cambio del realtime es
      // justamente el que hay que traer.
      this.cargarTurnos(true);
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
   * Empleado del turno. Es OBLIGATORIO: define la columna de la agenda y es quien
   * cobra la comision. Antes se derivaba del puesto cuando faltaba, porque
   * existian turnos viejos sin `empleado_id`; ya no hace falta ese fallback.
   */
  empleadoDeTurno(turno: any): number | null {
    return turno?.empleado_id ?? null;
  }

  nombreEmpleadoDeTurno(turno: any): string {
    const id = this.empleadoDeTurno(turno);
    if (!id) return 'Sin empleado';
    return this.empleados.find((e: any) => e.id === id)?.nombre || 'Sin empleado';
  }

  actualizarVista() {
    this.cdr.detectChanges();
  }

  ngOnDestroy() {
    window.removeEventListener('resize', this.alRedimensionar);
    this.subscription?.unsubscribe();
    this.subHorarios?.unsubscribe();
  }

  /**
   * Refleja el ancho de columna al cambiar el tamaño de la ventana.
   *
   * Se comparan los VALORES y no se setea siempre: si se asignara en cada
   * evento, el resize dispararia un ciclo de deteccion de cambios por pixel
   * durante un drag de ventana, que es lo que hace que las apps con scroll se
   * sientan trabadas al arrastrar el borde.
   *
   * El componente no es OnPush, asi que el evento (que entra por la zona de
   * Angular) dispara el render solo: no hace falta un `detectChanges` aca.
   */
  private alRedimensionar = () => {
    const nuevo = window.innerWidth;
    if (nuevo === this.anchoVentana) return;
    this.anchoVentana = nuevo;
  };

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

  /**
   * Rango que ya esta en memoria. Sirve para que moverse con las flechas no
   * vuelva a pegarle a la base si la semana pedida ya esta adentro.
   */
  private rangoTurnos: { desde: string; hasta: string } | null = null;

  /** 'YYYY-MM-DD' corrido `dias` para atras (o para adelante, si es negativo). */
  private correrDias(iso: string, dias: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    const fecha = new Date(y, m - 1, d);
    fecha.setDate(fecha.getDate() + dias);
    return this.formatearFechaLocal(fecha);
  }

  /**
   * Trae los turnos de la zona que se esta mirando, no la tabla entera.
   *
   * Se pide un colchon de 5 semanas para cada lado: alcanza para navegar con
   * las flechas sin volver a la base, y no baja anos de historia para mostrar
   * una semana. `forzar` lo usan el realtime y el primer render: ahi hay que
   * refrescar aunque el rango ya este cubierto, porque justo cambio un turno.
   */
  async cargarTurnos(forzar = false) {
    const foco = this.fechaISO;
    const cubierto = !forzar
      && this.rangoTurnos
      && this.rangoTurnos.desde <= this.correrDias(foco, -7)
      && this.rangoTurnos.hasta >= this.correrDias(foco, 7);

    if (cubierto) {
      // Los datos no cambian, pero la fecha elegida si: el input de la barra y
      // los titulos se tienen que repintar igual.
      this.cdr.detectChanges();
      return;
    }

    const desde = this.correrDias(foco, -35);
    const hasta = this.correrDias(foco, 35);
    // El rol empleado ve solo los turnos de su columna, y solo su columna. Las dos
    // cosas se filtran: con los turnos filtrados pero las columnas completas, la grilla
    // muestra los turnos de otra persona en la columna de al lado; al reves, la columna
    // propia aparece vacía.
    this.turnos = soloLosTurnosDe(await this.supabase.getTurnosEntre(desde, hasta), this.auth.empleadoParaFiltrarTurnos());
    this.rangoTurnos = { desde, hasta };
    this.limpiarCacheColumnas();
    this.ajustarLimitesConTurnos();
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

  /** El día que se está mirando, en formato YYYY-MM-DD (el que espera la validacion). */
  get fechaActualISO(): string {
    return this.fechaActual.toLocaleDateString('en-CA');
  }

  /**
   * El registro de `dias_cerrados` que cierra esta fecha, o `null` si abre.
   *
   * Un cierre puede cubrir un RANGO (`fecha` a `fecha_hasta`, para unas
   * vacaciones de varios días), así que no se busca por igualdad: se busca el
   * primer registro que incluya la fecha.
   *
   * Todo lo que necesita saber "está cerrado" y "por qué" sale de acá, para que
   * el rayado y el motivo nunca puedan quedar opinando distinto.
   */
  cierreDe(dia: Date): any | null {
    const fechaStr = dia.toLocaleDateString('en-CA');
    return this.diasCerrados.find(d => {
      const desde = d.fecha;
      const hasta = d.fecha_hasta || d.fecha;
      return fechaStr >= desde && fechaStr <= hasta;
    }) || null;
  }

  esDiaCerrado(dia: Date): boolean {
    return this.cierreDe(dia) !== null;
  }

  /**
   * Por qué está cerrado el día, para ponerlo al lado ("LUN 28/09 (vacaciones)").
   *
   * String vacío y no `null` para que el template pueda usar `*ngIf` directo y
   * no tener que distinguir dos "no hay motivo". Hay cierres sin motivo (el
   * campo es nullable en la base), y en ese caso sale el rayado pelado, que es
   * lo que hay que mostrar: no inventar un texto.
   */
  motivoDiaCerrado(dia: Date): string {
    const cierre = this.cierreDe(dia);
    return (cierre && cierre.motivo) || '';
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

  /**
   * QUÉ COLUMNAS APARECEN en una fecha dada. Esta es la regla central de la
   * agenda con columnas por empleado.
   *
   * Un empleado tiene columna si esta ACTIVO y ademas:
   *   - trabaja ese dia (jornada), o
   *   - tiene una ausencia ese dia      -> se muestra rayada, para que se vea
   *   - tiene turnos EN RIESGO ese dia  -> se muestra para poder resolverlos
   *
   * La tercera cláusula es la importante: sin ella, un turno que quedó fuera de
   * la jornada (al cambiarle los dias, o al cargarle una ausencia encima)
   * desapareceria de la agenda y no habria forma de verlo para reprogramarlo.
   *
   * Solo los INACTIVOS no tienen columna.
   */
  columnasPara(fecha: string): any[] {
    if (this.cacheColumnas[fecha]) return this.cacheColumnas[fecha];

    // El orden alfabetico se aplica ACÁ y no se delega en el ORDER BY del
    // servicio: es una decision de la pantalla, no una casualidad de la query.
    const empleados = [...(this.empleados || [])]
      .sort((a: any, b: any) => (a.nombre || '').localeCompare(b.nombre || '', 'es'));

    const cols = empleados
      .map((e: any) => {
        const ausencia = this.ausenciaDe(e.id, fecha);
        const estado = {
          activo: !!e.activo,
          trabaja: jornadaCubre(this.jornadaDe(e.id), fecha, '00:00', 1).ok,
          tieneAusencia: !!ausencia,
          tieneTurnosEnRiesgo: this.tieneTurnosEnRiesgo(e.id, fecha),
        };
        return {
          empleado: e,
          ...estado,
          ausencia,
          // Ausente de verdad = lo tapa una ausencia. Si solo no labra ese dia,
          // la columna sale por el turno en riesgo y se marca distinto.
          ausente: estado.tieneAusencia,
        };
      })
      // El filtro de columna del rol empleado va ANTES de `debeMostrarColumna`, y no
      // despues: si fuera despues, el empleado veria las columnas de los demas que
      // estan inactivos o de dia libre en su turno vacias, que es informacion que no
      // le corresponde y ademas lo confunde ("por que aparece Juan si hoy no labra").
      .filter((c: any) => soloLasColumnasDe([c], this.auth.empleadoParaFiltrarTurnos()).length > 0)
      .filter((c: any) => debeMostrarColumna(c));

    this.cacheColumnas[fecha] = cols;
    return cols;
  }

  /**
   * Estado de una columna PARA ESE dia de la semana.
   *
   * La lista de columnas es la union semanal (para que la grilla sea
   * rectangular), pero que un empleado este ausente el LUNES no quiere decir
   * que lo este el MARTES: el estado se sigue preguntando dia por dia.
   */
  /** Columnas de la vista Dia. */
  get columnasAgenda(): any[] {
    return this.columnasPara(this.fechaISO);
  }

  /** La cache se invalida cuando cambian los datos que la sostienen. */
  private limpiarCacheColumnas() {
    this.cacheColumnas = {};
  }

  /** Ausencia del empleado en esa fecha, o null. */
  ausenciaDe(empleadoId: number, fecha: string): any {
    const suyas = this.ausencias.filter((a: any) => a.empleado_id === empleadoId);
    // Mediodia como referencia: alcanza para marcar la columna del dia.
    return turnoTocadoPorAusencia(suyas, fecha, '12:00', 1);
  }

  /** ¿Tiene este empleado algun turno en riesgo en esa fecha? */
  tieneTurnosEnRiesgo(empleadoId: number, fecha: string): boolean {
    return (this.turnos || []).some(
      (t: any) => t.empleado_id === empleadoId
        && t.fecha === fecha
        && t.estado !== 'cancelado'
        && this.turnoEnRiesgo(t)
    );
  }

  /**
   * Delega en el servicio: antes la Agenda tenia su PROPIA copia de esta
   * funcion y por eso no se enteraba de las reglas nuevas.
   */
  empleadoAgendable(e: any, fecha?: string, hora?: string, dur?: number): boolean {
    return this.supabase.empleadoEsAgendable(e, fecha, hora, dur, this.ausencias) as boolean;
  }

  /** Motivo por el que este empleado no puede atender en esa fecha (o null). */
  motivoColumna(e: any, fecha: string, hora = '09:00', dur = 45): string | null {
    return this.supabase.motivoDeNoAtender(e, fecha, hora, dur, this.ausencias);
  }

  /**
   * Motivo para pintar la columna rayada: ausencia, o dia que no labra.
   * Devuelve null cuando esta todo bien.
   */
  motivoColumnaAusente(empleadoId: number, fecha: string): string | null {
    const a = this.ausenciaDe(empleadoId, fecha);
    if (a) return textoAusencia(a);
    const j = jornadaCubre(this.jornadaDe(empleadoId), fecha, '00:00', 1);
    return j.ok ? null : (j.motivo || null);
  }

  /** ¿Este turno se queda sin cobertura por una ausencia? (no se mueve solo) */
  turnoEnRiesgo(t: any): boolean {
    if (!t?.empleado_id) return false;
    const fecha = t.fecha;
    const hora = (t.hora_inicio || t.hora || '09:00').slice(0, 5);
    const dur = t.duracion_minutos || 45;
    if (!jornadaCubre(this.jornadaDe(t.empleado_id), fecha, hora, dur).ok) return true;
    // this.ausencias trae las de TODOS: hay que quedarse con las de este.
    const suyas = this.ausencias.filter((a: any) => a.empleado_id === t.empleado_id);
    return !!turnoTocadoPorAusencia(suyas, fecha, hora, dur);
  }

  /** Jornada del empleado (lo cacheamos al cargar para no consultarla por celda). */
  jornadaDe(empleadoId: number): any {
    return this.jornadas[empleadoId] || null;
  }

  /**
   * Indice de la columna donde cae un turno: la de su empleado.
   *
   * No existe columna "Sin asignar": el empleado es obligatorio al agendar. Si
   * aun asi el empleado no esta entre las columnas visibles (esta inactivo, o
   * fue dado de baja despues de agendar), el turno cae en la ultima columna
   * para que al menos se vea en vez de desaparecer.
   */
  columnaDeTurno(turno: any, fecha?: string, _mini = false): number {
    const cols = this.columnasPara(fecha || turno?.fecha || this.fechaISO);
    if (!cols.length) return 0;
    const idx = cols.findIndex((c: any) => c.empleado.id === turno?.empleado_id);
    return idx >= 0 ? idx : cols.length - 1;
  }

  posicionTurno(turno: any, _columnas?: any, mini = false): { top: number, height: number, left: string, width: string } {
    const inicio = turno.hora_inicio || turno.hora || '00:00';
    const h = parseInt(inicio.slice(0, 2));
    const m = parseInt(inicio.slice(3, 5));
    const duracion = turno.duracion_minutos || 45;
    const minutosDesdeInicio = (h - this.horaInicio) * 60 + m;
    const offset = mini ? H_HEADER_MINI : H_HEADER_COLUMNAS;

    // Cada dia se mide con SU PROPIA gente. En la vista Semana un martes con
    // dos empleados no puede usar el total del lunes con tres: el ancho del
    // bloque se calcula como porcentaje, asi que con el total equivocado el
    // turno queda mas angosto que su columna.
    const cols = this.columnasDe(turno, mini);
    const total = Math.max(cols.length, 1);
    const col = Math.min(this.columnaDeTurno(turno, undefined, mini), total - 1);
    const pct = 100 / total;

    return {
      // El +8 replica el margen de topParaHora: sin esto el bloque cae arriba de la linea.
      top: minutosDesdeInicio * PX_POR_MINUTO + offset + 8,
      height: Math.max(duracion * PX_POR_MINUTO - 6, 22),
      // El header y la banda usan `flex: 1 1 0` SIN margen: cada uno es 1/n del
      // ancho. El bloque va 3px adentro de su columna para que no toque el
      // borde, y por eso el ancho es `pct% - 6px`.
      left: `calc(${pct * col}% + ${GAP_COLUMNA}px)`,
      width: `calc(${pct}% - ${GAP_COLUMNA * 2}px)`
    };
  }

  /**
 * Cuanto contenido cabe segun la duracion del turno.
 * A 1.2 px por minuto un turno de 45 min mide 48px, y las 3 lineas
 * (hora+cliente / servicio / precio) necesitan ~55px: el precio quedaba
 * cortado. Con esto se ocultan de abajo hacia arriba.
 *   2 = header + servicio + precio   (>= 50 min)
 *   1 = header + servicio             (>= 40 min)
 *   0 = solo header                   (< 40 min)
 */
nivelContenido(turno: any): number {
  const dur = Number(turno?.duracion_minutos) || 45;
  if (dur >= 50) return 2;
  if (dur >= 40) return 1;
  return 0;
}

claseBloque(turno: any, mini: boolean): string {
  if (mini) {
    // Vista semana: 2 filas (cliente + servicio) ≈ 34px. Con menos de 35 min
    // el bloque mide menos que eso y hay que sacar la fila del servicio.
    const dur = Number(turno?.duracion_minutos) || 45;
    return `bloque-turno-semana mini-nivel-${dur >= 35 ? 1 : 0}`;
  }
  return `bloque-turno nivel-${this.nivelContenido(turno)}`;
}

/** Ancho de UNA columna de empleado, en px. Base de todo el layout. */
  get anchoColEmpleado(): number {
    if (this.vista !== 'dia') return this.pantallaChica ? ANCHO_COL_SEMANA_CHICA : ANCHO_COL_SEMANA;
    return this.pantallaChica ? ANCHO_COL_DIA_CHICA : ANCHO_COL_DIA;
  }

  /**
   * Cuánto ocupa CADA columna de empleado, contando el margen de los dos lados.
   *
   * El margen real lo ponen `.columna-header` y `.columna-fondo-celda` con
   * `margin: 0 GAP_COLUMNApx`, o sea 3px de cada lado = 6px. Antes esta cuenta
   * decía 4, y por eso `anchoColumnas` pedía 2px menos por columna de los que
   * la grilla necesita de verdad: al llegar al tope del scroll horizontal las
   * columnas quedaban 2px más angostas de lo que el cálculo promete.
   *
   * Sale del MISMO número que usa `posicionTurno`, no de un literal suelto.
   */
  get gapColumna(): number {
    return GAP_COLUMNA * 2;
  }

  get anchoColumnas(): string {
    const n = Math.max(this.columnasAgenda.length, 1);
    return `${n * (this.anchoColEmpleado + this.gapColumna)}px`;
  }

  /**
   * Columnas de un dia de la semana. Cada dia muestra SOLO a quien trabaja
   * ese dia (o tiene ausencia, o turnos en riesgo): una persona que no labra
   * no tiene columna, asi que se lee de un vistazo quienes atienden.
   */
  columnasDe(diaOrTurno: any, _mini = false): any[] {
    // Acepta un Date o un turno: es lo unico que cambia entre el template y
    // el posicionamiento.
    const fecha = diaOrTurno instanceof Date
      ? this.fechaISOde(diaOrTurno)
      : (diaOrTurno?.fecha || this.fechaISO);
    return this.columnasPara(fecha);
  }

  /**
   * Ancho de un dia de la semana: el de SU gente, no el del dia mas lleno.
   *
   * Este era el bug del hueco: todos los dias reservaban el ancho del maximo y
   * los que labran menos dejaban columnas en blanco al final. Cada dia mide lo
   * que necesita y se termina el espacio de reserva.
   */
  anchoDeDia(dia: Date): { [k: string]: string } {
    const n = Math.max(this.columnasDe(dia).length, 1);
    // Proporcional, no píxeles: `flex-grow = n` reparte el ancho disponible entre
    // los días en la misma proporción que sus columnas de empleado. Un día con un
    // solo empleado se lleva 1/7 de la pantalla y los de 3 se llevan 3/7, que es lo
    // que el ojo espera. Con ancho fijo quedaban seis columnas angostas pegadas a
    // la izquierda y media pantalla en blanco a la derecha.
    //
    // Se devuelve un objeto y no un string porque `[ngStyle]` con "a: b; c: d" no
    // aplica nada: el atributo queda vacío y la columna vuelve al ancho de la clase.
    // `min-width` sigue fijando el piso (una columna legible).
    return {
      flex: `${n} 1 0`,
      'min-width': `${n * (this.anchoColEmpleado + this.gapColumna)}px`,
    };
  }

  /**
   * Ancho MÍNIMO de la grilla semanal, en píxeles: la columna de horas más el piso
   * de cada día.
   *
   * Antes esto era `'100%'` y no se notaba, porque mientras todo entrara en pantalla
   * daba lo mismo. El problema aparece cuando la semana es más ancha que la pantalla
   * y hay que scrollear en horizontal: la grilla se quedaba en el ancho del
   * contenedor (898px medidos) y los días, con su `min-width`, se salían de la caja
   * hacia la derecha.
   *
   * El `.header-semana` es `width: 100%` de esta grilla, así que medía 898 también y
   * su fondo blanco tapaba SOLO lunes y martes. Al scrollear, los días siguientes
   * seguían viéndose pero sin fondo, y abajo aparecían los colores de las columnas de
   * empleados en la fila del encabezado. "Se bloquea solo lunes" era exactamente eso:
   * el fondo que se bloquea es el del header, y el header no daba de ancho.
   *
   * El crecimiento de la grilla va por `width` (este valor) y el llenado de pantalla
   * por `min-width: 100%` en el CSS: gana el más grande de los dos. Con una semana
   * de un solo empleado por día la grilla se estira a la pantalla y `flex-grow`
   * reparte, como siempre.
   */
  get anchoGrillaSemana(): string {
    const pisoDias = this.diasDeSemana.reduce((sum, dia) => {
      const n = Math.max(this.columnasDe(dia).length, 1);
      return sum + n * (this.anchoColEmpleado + this.gapColumna);
    }, 0);
    return `${ANCHO_COL_HORAS + pisoDias}px`;
  }


  /** Offset vertical que dejan los headers de columnas. */
  get offsetHeader(): number {
    return this.vista === 'dia' ? H_HEADER_COLUMNAS : H_HEADER_MINI;
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

  /** 'YYYY-MM-DD' de un Date de la grilla semanal. La vista Semana lo pide por dia. */
  fechaISOde(dia: Date): string {
    return this.formatearFechaLocal(dia);
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
    this.cargarTurnos();
  }

  navegarSemana(dir: number) {
    const d = new Date(this.fechaActual);
    d.setDate(d.getDate() + dir * 7);
    this.fechaActual = d;
    this.cargarTurnos();
  }

  irHoy() {
    this.fechaActual = new Date();
    this.cargarTurnos();
  }

  /**
   * Salta a la fecha elegida en el calendario.
   *
   * OJO con armar la fecha: `new Date('2026-10-04')` se interpreta como
   * MEDIANOCHE UTC, que en Argentina (UTC-3) es el 03/10 a las 21:00 local. Un
   * día antes, siempre. Por eso el parseo no es un `new Date` pelado.
   *
   * En la vista Semana no hay que hacer nada más: `diasDeSemana` ya normaliza
   * al lunes de esa semana.
   *
   * Recarga solo si la fecha cae fuera del colchon ya cargado: mover el
   * calendario dentro de la misma zona no vuelve a pegarle a la base.
   */
  irAFecha(iso: string) {
    // El parseo vive en `fechaDesdeISO` (utils/fechas) y lo comparte con el
    // Dashboard, que tiene el mismo boton de calendario. Con dos copias de
    // esta logica un dia se desincroniza del otro, y no se nota hasta que
    // alguien busca el 28/09 en un lado y no lo encuentra.
    const d = fechaDesdeISO(iso);
    if (d) {
      this.fechaActual = d;
      this.cargarTurnos();
    }
  }

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
  /**
   * Salta a la ficha del cliente en Personas → Clientes.
   *
   * El popup del turno mostraba el nombre pero no habia forma de abrir la ficha
   * desde ahi: habia que ir a Personas y buscarlo a mano.
   */
  irAlCliente(turno: any) {
    if (!turno) return;
    const id = turno.cliente_id;
    this.router.navigate(['/personas/clientes'], id ? { queryParams: { cliente: id } } : {});
  }

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
    // Limpiar tambien los carteles del form de reprogramar: si no, reaparecen
    // al abrir el siguiente turno.
    this.modoEditarTurno = false;
    this.errorEditarTurno = '';
    this.empleadoReprogramarNoPuede = false;
    this.empleadosReprogramar = this.empleados;
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
      if (!confirmarVolverAPendiente(this.turnoSeleccionado)) return;
      const id = this.turnoSeleccionado.id;
      await this.supabase.volverAPendiente(id);
      await this.cargarTurnos(true); // cargarDatos() en dashboard
      this.cerrarPopup();
      return;
    }
    const id = this.turnoSeleccionado.id;
    await this.supabase.updateEstadoTurno(id, estado);
    await this.cargarTurnos(true);
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

    // Sin empleado no se puede guardar: se perderia la comision y el turno
    // no tendria columna en la agenda.
    if (!this.atendidoEmpleadoId) {
      this.errorAtendido = '❌ Elegí el empleado que atendió.';
      this.cdr.detectChanges();
      return;
    }

    // Jornada + ausencias del empleado que se esta anotando
    const puede = await this.supabase.empleadoPuedeAtender(
      this.atendidoEmpleadoId,
      this.turnoSeleccionado.fecha,
      (this.turnoSeleccionado.hora_inicio || this.turnoSeleccionado.hora || '00:00').slice(0, 5),
      this.atendidoServicio?.duracion_minutos || this.turnoSeleccionado.duracion_minutos || 45,
      this.ausencias
    );
    if (!puede.ok) {
      const nombreEmp = this.empleados.find((e: any) => e.id === this.atendidoEmpleadoId)?.nombre;
      this.errorAtendido = `❌ ${nombreEmp || 'Ese empleado'}: ${puede.motivo}.`;
      this.cdr.detectChanges();
      return;
    }
    const dur = servicio?.duracion_minutos || this.turnoSeleccionado.duracion_minutos || 45;
    const ocupado = await this.supabase.empleadoEstaOcupado(
      this.atendidoEmpleadoId,
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
      await this.cargarTurnos(true);
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

  /** Comisión del empleado para el servicio elegido en el form de reprogramar. */
  getComisionEmpleadoServicioReprogramar(empleadoId: number): number {
    if (!this.nuevoServicioId) return 0;
    const comision = this.comisionesPorServicio.find(
      (c: any) => c.empleado_id === empleadoId && c.servicio_id == this.nuevoServicioId
    );
    if (comision) return comision.porcentaje;
    const emp = this.empleados.find((e: any) => e.id === empleadoId);
    return emp?.comision_porcentaje || 0;
  }

  /**
   * Filtra el selector de "Empleado que atiende" del form de reprogramar.
   * Se quedan los que pueden trabajar esa fecha/hora, MAS el que ya está
   * asignado: si no, al guardar un turno que no se tocó se perdería el empleado.
   */
  async actualizarEmpleadosReprogramar() {
    if (!this.nuevaFecha) {
      this.empleadosReprogramar = this.empleados;
      this.empleadoReprogramarNoPuede = false;
      return;
    }
    const servicio = this.servicios.find((s: any) => s.id == Number(this.nuevoServicioId));
    const dur = servicio?.duracion_minutos || 45;
    const disponibles = await this.supabase.getEmpleadosDisponibles(
      this.nuevaFecha, this.nuevaHora || '00:00', dur, this.ausencias
    );
    const puede = (e: any) =>
      !!disponibles.some((d: any) => d.empleado_id === e.id && d.puede_atender);

    this.empleadosReprogramar = this.empleados.filter(
      (e: any) => puede(e) || e.id === this.nuevoEmpleadoId
    );
    const elegido = this.empleados.find((e: any) => e.id === this.nuevoEmpleadoId);
    this.empleadoReprogramarNoPuede = !!elegido && !puede(elegido);
    // Sin esto el cartel queda pegado: el metodo es async y el cambio de
    // estado pasa despues del await, fuera del ciclo de deteccion.
    this.cdr.detectChanges();
  }

  /** Sale del form de reprogramar limpiando todos los carteles. */
  salirDeEditarTurno() {
    this.modoEditarTurno = false;
    this.errorEditarTurno = '';
    this.empleadoReprogramarNoPuede = false;
    this.empleadosReprogramar = this.empleados;
    this.cdr.detectChanges();
  }

  activarEditarTurno() {
    this.modoEditarTurno = true;
    this.nuevaFecha = this.turnoSeleccionado.fecha;
    this.nuevaHora = this.turnoSeleccionado.hora_inicio?.slice(0,5) || this.turnoSeleccionado.hora?.slice(0,5) || '';
    this.nuevoServicioId = this.turnoSeleccionado.servicio_id;
    this.nuevoEmpleadoId = this.empleadoDeTurno(this.turnoSeleccionado);
    this.errorEditarTurno = '';
    this.actualizarEmpleadosReprogramar();
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

      // El empleado es obligatorio: define la columna de la agenda y la comision.
      if (!this.nuevoEmpleadoId) {
        this.errorEditarTurno = '❌ Elegí el empleado que atiende.';
        return;
      }

      // Jornada + ausencias del empleado elegido
      const puede = await this.supabase.empleadoPuedeAtender(
        this.nuevoEmpleadoId, this.nuevaFecha, this.nuevaHora,
        this.nuevoServicio?.duracion_minutos || 45, this.ausencias
      );
      if (!puede.ok) {
        const nombreEmp = this.empleados.find((e: any) => e.id === this.nuevoEmpleadoId)?.nombre;
        this.errorEditarTurno = `❌ ${nombreEmp || 'Ese empleado'}: ${puede.motivo}.`;
        return;
      }

      // Y no puede pisar otro turno suyo en ese rango
      const ocupado = await this.supabase.empleadoEstaOcupado(
        this.nuevoEmpleadoId, this.nuevaFecha, this.nuevaHora,
        servicio.duracion_minutos, this.turnoSeleccionado.id
      );
      if (ocupado) {
        const nombreEmp = this.empleados.find((e: any) => e.id === this.nuevoEmpleadoId)?.nombre;
        this.errorEditarTurno = `❌ ${nombreEmp || 'Ese empleado'} ya tiene un turno en ese horario.`;
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
        duracion_minutos: servicio.duracion_minutos,
        // Sin esto el selector de empleado era decorativo: el turno se
        // reprogramaba pero se mantenía el empleado anterior.
        empleado_id: this.nuevoEmpleadoId
      });
      await this.cargarTurnos(true);
      await this.iniciarNotificacionPostergacion(this.nuevaFecha, this.nuevaHora, servicio.nombre);
    } catch (e) {
      console.error('Error en confirmarEditarTurno:', e);
      this.errorEditarTurno = '❌ Error al guardar. Intentá de nuevo.';
    } finally {
      // El reset va acá y no en cada return: con 4 caminos de salida
      // 'editandoTurno = false' es facil olvidarse y el boton queda en
      // "Guardando..." para siempre.
      this.editandoTurno = false;
      this.cdr.detectChanges();
    }
  }

  async iniciarCancelacion() {
    if (this.turnoSeleccionado) {
      await this.supabase.updateEstadoTurno(this.turnoSeleccionado.id, 'cancelado');
      if (this.telefonoDe(this.turnoSeleccionado) &&
          confirm('¿Querés enviarle un mensaje de WhatsApp al cliente?')) {
        this.motivoCancelacion = '';
        this.errorMensaje = '';
        this.linkWhatsapp = '';
        this.mostrarPopupCancelacion = true;
      } else {
        await this.cerrarPopupCancelacion();
      }
    } else {
      await this.cerrarPopupCancelacion();
    }
    this.cdr.detectChanges();
  }

  async enviarMensajeCancelacion() {
    const telefono = this.telefonoDe(this.turnoSeleccionado);
    if (!telefono) return;
    this.enviandoMensaje = true;
    this.errorMensaje = '';
    this.linkWhatsapp = '';
    try {
      const fecha = this.formatearFechaStr(this.turnoSeleccionado.fecha);
      const hora = this.formatearHora(this.turnoSeleccionado.hora_inicio || this.turnoSeleccionado.hora);
      const mensaje = `Estimado cliente:\n\n📆 El turno del día *${fecha}* a las *${hora}* hs ha sido *cancelado* debido ${this.motivoCancelacion}.\nLamentamos los inconvenientes causados.😔\n${this.lineaDeContacto()}\n\nAtte. *${this.nombreNegocio}*`;

      const r = await this.supabase.enviarMensajeCliente(telefono, mensaje);
      if (!r.ok) {
        // No salió: NO se cierra el popup. Cerrarlo con un "listo" cuando Meta
        // rechazó el mensaje es lo mismo que el webhook viejo, que fallaba en
        // silencio: el cliente se entera cuando llega al local.
        this.errorMensaje = 'No se pudo enviar.';
        this.linkWhatsapp = this.linkWhatsappDe(telefono, mensaje);
        return;
      }
    } catch (e) {
      console.error('Error enviando mensaje:', e);
      this.errorMensaje = 'No se pudo enviar.';
      return;
    } finally {
      this.enviandoMensaje = false;
      this.cdr.detectChanges();
    }
    await this.cerrarPopupCancelacion();
    this.cdr.detectChanges();
  }

  /** WhatsApp con el mensaje ya escrito, para mandarlo a mano si Meta no lo deja. */
  linkWhatsappDe(telefono: string, texto: string): string {
    const digitos = (telefono || '').replace(/\D/g, '').slice(-10);
    return `https://wa.me/549${digitos}?text=${encodeURIComponent(texto)}`;
  }

  /**
   * El renglón de contacto del pie de los mensajes de cancelación/reprogramación.
   *
   * Antes decía "escribí 1 o reservar" / "escribí 2 o turnos": eran los comandos
   * del bot viejo y hoy no aplican. Lo que sirve es el teléfono del local para
   * cualquier consulta. Si no hay número cargado en Configuración no se inventa
   * uno: el renglón no sale.
   */
  lineaDeContacto(): string {
    const tel = (this.telefonoEmergencia || '').trim();
    return tel ? `Para cualquier consulta comunicate al ${tel}.` : '';
  }

  /**
   * Cierra el popup de cancelación y recarga los turnos.
   *
   * La recarga va acá y no en cada botón porque el turno YA se canceló al abrir
   * este popup: si el usuario elige "Omitir", sin esto la agenda seguía
   * mostrándolo como pendiente hasta recargar la página.
   */
  async cerrarPopupCancelacion() {
    this.mostrarPopupCancelacion = false;
    this.cerrarPopup();
    await this.cargarTurnos(true);
  }

  async iniciarNotificacionPostergacion(nuevaFecha: string, nuevaHora: string, nuevoServicio: string) {
    const telefonoCliente = this.telefonoDe(this.turnoSeleccionado);
    if (!telefonoCliente) {
      await this.cerrarPopupPostergacion();
    } else if (confirm('¿Querés enviarle un mensaje de WhatsApp al cliente?')) {
      this.motivoPostergacion = '';
      this.errorMensaje = '';
      this.linkWhatsapp = '';
      this._nuevaFechaPostergacion = nuevaFecha;
      this._nuevaHoraPostergacion = nuevaHora;
      this._nuevoServicioPostergacion = nuevoServicio;
      this.mostrarPopupPostergacion = true;
    } else {
      await this.cerrarPopupPostergacion();
    }
    this.cdr.detectChanges();
  }

  async enviarMensajePostergacion() {
    const telefono = this.telefonoDe(this.turnoSeleccionado);
    if (!telefono) return;
    this.enviandoMensajePostergacion = true;
    this.errorMensaje = '';
    this.linkWhatsapp = '';
    try {
      const fecha = this.formatearFechaStr(this._nuevaFechaPostergacion);
      const mensaje = `Estimado cliente:\n\n📆 Tu turno ha sido *reprogramado* para el día *${fecha}* a las *${this._nuevaHoraPostergacion}* hs (para un: *${this._nuevoServicioPostergacion}*).${this.motivoPostergacion ? this.motivoPostergacion + '.' : ''}\nLamentamos los inconvenientes causados.😔\n${this.lineaDeContacto()}\n\nAtte. *${this.nombreNegocio}*`;

      const r = await this.supabase.enviarMensajeCliente(telefono, mensaje);
      if (!r.ok) {
        this.errorMensaje = 'No se pudo enviar.';
        this.linkWhatsapp = this.linkWhatsappDe(telefono, mensaje);
        return;
      }
    } catch (e) {
      console.error('Error enviando mensaje:', e);
      this.errorMensaje = 'No se pudo enviar.';
      return;
    } finally {
      this.enviandoMensajePostergacion = false;
      this.cdr.detectChanges();
    }
    await this.cerrarPopupPostergacion();
    this.cdr.detectChanges();
  }

  /**
   * Cierra el popup de reprogramación y recarga los turnos.
   *
   * Mismo motivo que en cancelación: el cambio ya se guardó antes de mostrar
   * este popup, así que "Omitir" también tiene que refrescar la pantalla.
   */
  async cerrarPopupPostergacion() {
    this.mostrarPopupPostergacion = false;
    this.cerrarPopup();
    await this.cargarTurnos(true);
  }
 }
