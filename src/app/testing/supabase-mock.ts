import { SupabaseService } from '../services/supabase';

/**
 * Datos de prueba. Son COPIAS de los reales de `test-lavadero`: si el mock
 * cuelga de la base, el test falla cuando alguien cambia un dato, y el fallo
 * dice "cambiaste la base" en vez de "se rompió la lógica".
 */

/** Esteban: L,M,J,V (no miércoles, no sábado). */
export const EMP_JUAN: any = {
  id: 1, nombre: 'Juan Pérez', telefono: '3764123456', activo: true,
  comision_porcentaje: 15,
  jornada: [
    { activo: false, hora_inicio: null, hora_fin: null }, // dom
    { activo: true, hora_inicio: null, hora_fin: null },  // lun
    { activo: true, hora_inicio: null, hora_fin: null },  // mar
    { activo: true, hora_inicio: null, hora_fin: null },  // mie
    { activo: true, hora_inicio: null, hora_fin: null },  // jue
    { activo: true, hora_inicio: null, hora_fin: null },  // vie
    { activo: false, hora_inicio: null, hora_fin: null }, // sab
  ],
};

export const EMP_ESTEBAN: any = {
  id: 8, nombre: 'Esteban Agüero', telefono: '3815512745', activo: true,
  comision_porcentaje: 25,
  jornada: [
    { activo: false, hora_inicio: null, hora_fin: null }, // dom
    { activo: true, hora_inicio: null, hora_fin: null },  // lun
    { activo: true, hora_inicio: null, hora_fin: null },  // mar
    { activo: false, hora_inicio: null, hora_fin: null }, // mie  <-- no trabaja
    { activo: true, hora_inicio: null, hora_fin: null },  // jue
    { activo: true, hora_inicio: null, hora_fin: null },  // vie
    { activo: false, hora_inicio: null, hora_fin: null }, // sab
  ],
};

/** Inactivo a propósito: para probar que NO tiene columna en la agenda. */
export const EMP_INACTIVO: any = {
  id: 99, nombre: 'Pedro Inactivo', telefono: null, activo: false,
  comision_porcentaje: 10,
  jornada: [
    { activo: true, hora_inicio: null, hora_fin: null },
    { activo: true, hora_inicio: null, hora_fin: null },
    { activo: true, hora_inicio: null, hora_fin: null },
    { activo: true, hora_inicio: null, hora_fin: null },
    { activo: true, hora_inicio: null, hora_fin: null },
    { activo: true, hora_inicio: null, hora_fin: null },
    { activo: true, hora_inicio: null, hora_fin: null },
  ],
};

/** Copia profunda de un empleado, para que un test no mute el fixture de otro. */
export function cloneEmpleado(e: any): any {
  return { ...e, jornada: JSON.parse(JSON.stringify(e.jornada)) };
}

export function turno(over: Record<string, any> = {}): any {
  return {
    id: 1, fecha: '2026-10-02', hora: '10:00:00', hora_inicio: '10:00:00',
    hora_fin: '11:00:00', duracion_minutos: 60, estado: 'pendiente',
    empleado_id: 1, cliente_id: 1, cliente_nombre: 'Daniel Prueba',
    cliente_telefono: null, servicio_id: 1, servicio_nombre: 'Lavado simple',
    precio: 12000, metodo_pago: null, precio_final: null,
    servicio_nombre_final: null, servicio_id_final: null,
    puesto_id: 1,   // columna muerta: la app ya no la lee
    ...over,
  };
}

/**
 * Stub de SupabaseService.
 *
 * Todos los métodos devuelven `[]` o `{}` por defecto, así que un test solo
 * tiene que sobreescribir lo que le importa. Los que devuelven datos usan
 * promesas resueltas porque los componentes los esperan con `await`.
 *
 * `llamadas` registra qué se pidió, para poder afirmar que no se consulta la
 * tabla `puestos` (que ya no existe) ni nada que se haya retirado.
 */
export function crearSupabaseMock(over: Record<string, any> = {}) {
  const noop = () => {};
  const vacio = () => Promise.resolve([]);

  const base: any = {
    // --- datos de lectura que los componentes usan al iniciar ---
    getTurnos: vacio,
    getTurnosHoy: vacio,
    getEmpleados: () => Promise.resolve([EMP_ESTEBAN, EMP_JUAN]),
    getTodosEmpleados: () => Promise.resolve([EMP_ESTEBAN, EMP_JUAN]),
    getServicios: () => Promise.resolve([
      { id: 1, nombre: 'Lavado simple', precio: 12000, duracion_minutos: 45, activo: true },
      { id: 2, nombre: 'Lavado completo', precio: 20000, duracion_minutos: 90, activo: true },
    ]),
    getMetodosPago: () => Promise.resolve([{ id: 1, nombre: 'Efectivo' }]),
    getComisionesEmpleado: () => Promise.resolve([]),
    getAusencias: () => Promise.resolve([]),
    getDiasCerrados: () => Promise.resolve([]),
    getHorarios: () => Promise.resolve([
      { dia_semana: 1, hora_inicio: '08:00', hora_fin: '20:00', activo: true },
      { dia_semana: 2, hora_inicio: '08:00', hora_fin: '20:00', activo: true },
      { dia_semana: 3, hora_inicio: '08:00', hora_fin: '20:00', activo: true },
      { dia_semana: 4, hora_inicio: '08:00', hora_fin: '20:00', activo: true },
      { dia_semana: 5, hora_inicio: '08:00', hora_fin: '20:00', activo: true },
      { dia_semana: 6, hora_inicio: '08:00', hora_fin: '20:00', activo: true },
    ]),
    getTelefonosPorCliente: () => Promise.resolve({}),
    calcularComisiones: vacio,
    buscarClientes: () => Promise.resolve([]),

    // --- disponibilidad ---
    getEmpleadosDisponibles: () => Promise.resolve([]),
    getPrimerEmpleadoLibre: () => Promise.resolve(null),
    empleadoPuedeAtender: () => Promise.resolve({ ok: true }),
    empleadoEstaOcupado: () => Promise.resolve(false),

    // --- escritura ---
    editarTurno: () => Promise.resolve(),
    crearTurnoManual: () => Promise.resolve({}),
    crearEmpleado: (e: any) => Promise.resolve(e),
    crearAusencia: (a: any) => Promise.resolve(a),
    eliminarAusencia: noop,
    updateEmpleado: () => Promise.resolve(),
    updateEstadoTurno: () => Promise.resolve(),
    marcarAtendido: () => Promise.resolve(),
    volverAPendiente: () => Promise.resolve(),
    getTurnosPendientesDe: vacio,
    upsertComisionEmpleado: () => Promise.resolve(),
    deleteComisionEmpleado: () => Promise.resolve(),
    crearCliente: () => Promise.resolve({}),
    verificarNombreDuplicado: () => Promise.resolve(false),
    normalizarNombre: (n: string) => n,

    // --- Ganancias ---
    // OJO: el real filtra `estado = 'atendido'` DENTRO de la query. Por eso los
    // getters de Ganancias pueden sumar todo sin filtrar. Si el mock no lo
    // replica, un test podría "probar" que el componente filtra cuando en
    // realidad lo hace la base.
    getGanancias: vacio,

    // --- Clientes ---
    getClientes: () => Promise.resolve([]),
    getTurnosCliente: vacio,
    updateCliente: () => Promise.resolve(),
    agregarTelefono: (_id: number, tel: string) => Promise.resolve({ id: 99, telefono: tel, principal: true }),
    editarTelefono: () => Promise.resolve(),
    eliminarTelefono: () => Promise.resolve(),
    marcarTelefonoPrincipal: () => Promise.resolve(),
    fusionarClientes: () => Promise.resolve(),

    // --- Configuracion ---
    getConfiguracion: () => Promise.resolve([]),
    upsertConfiguracion: () => Promise.resolve(),
    createDiasCerrados: (fecha: string, hasta: any, motivo: string) =>
      Promise.resolve({ id: 99, fecha, fecha_hasta: hasta, motivo }),
    updateDiasCerrados: () => Promise.resolve(),
    deleteDiasCerrados: () => Promise.resolve(),
    updateHorario: () => Promise.resolve(),
    createHorario: (h: any) => Promise.resolve({ id: 99, ...h }),
    deleteHorario: () => Promise.resolve(),
    updateServicio: () => Promise.resolve(),
    createServicio: (s: any) => Promise.resolve({ id: 99, ...s }),
    deleteServicio: () => Promise.resolve(),
    createMetodoPago: (nombre: string, emoji: string) => Promise.resolve({ id: 99, nombre, emoji, activo: true }),
    updateMetodoPago: () => Promise.resolve(),
    deleteMetodoPago: () => Promise.resolve(),
    // --- Auth / password ---
    verificarUsuario: () => Promise.resolve(true),
    cambiarPassword: () => Promise.resolve(),

    // --- Caja: pagos a empleados ---
    // `getComisionesPeriodo` es la versión de UNA consulta para todos los
    // empleados. Si un test necesita otra cosa, que la sobreescriba.
    getPagosEmpleado: vacio,
    crearPagoEmpleado: (p: any) => Promise.resolve({ id: 1, ...p }),
    actualizarPagoEmpleado: (id: number, p: any) => Promise.resolve({ id, ...p }),
    eliminarPagoEmpleado: () => Promise.resolve(),
    getComisionesPeriodo: vacio,

    // --- Caja: proveedores y compras ---
    getProveedores: () => Promise.resolve([]),
    crearProveedor: (p: any) => Promise.resolve({ id: 1, ...p }),
    actualizarProveedor: (id: number, p: any) => Promise.resolve({ id, ...p }),
    inactivarProveedor: () => Promise.resolve(),
    eliminarProveedor: () => Promise.resolve(),
    getCompras: vacio,
    crearCompra: (c: any) => Promise.resolve({ id: 1, ...c }),
    actualizarCompra: (id: number, c: any) => Promise.resolve({ id, ...c }),
    eliminarCompra: () => Promise.resolve(),

    // --- realtime: en tests no hay suscripciones ---
    suscribirTurnos: () => ({ unsubscribe: noop }),
    suscribirHorarios: () => ({ unsubscribe: noop }),

    /** Qué métodos se llamaron. Para afirmar que no se toca lo retirado. */
    llamadas: [] as string[],
  };

  // IMPORTANTE: `over` se aplica ANTES de envolver. Si se hiciera después,
  // Object.assign reemplazaría los métodos ya envueltos por los de `over` y
  // esos dejarían de registrarse en `llamadas`.
  const mock: any = Object.assign(base, over);

  // Envuelve todo para registrar las llamadas sin tener que hacerlo a mano.
  for (const nombre of Object.keys(mock)) {
    if (nombre === 'llamadas' || typeof mock[nombre] !== 'function') continue;
    const original = mock[nombre];
    mock[nombre] = (...args: any[]) => {
      mock.llamadas.push(nombre);
      return original(...args);
    };
  }

  return mock;
}

/**
 * Stub de AuthService. Configuración lo usa para hashear y para saber quién es
 * el usuario. El hash real no importa para estos tests: lo que se verifica es
 * que se verifique la contraseña ACTUAL antes de cambiar la nueva.
 */
export function crearAuthMock(over: Record<string, any> = {}) {
  return {
    sha256: (s: string) => Promise.resolve(`hash:${s}`),
    getUsuario: () => 'duk_e',
    ...over,
  };
}

/** Cliente de prueba con dos teléfonos. Copia profunda: `clonarCliente()`. */
export const CLI_DANIEL: any = {
  id: 1, nombre: 'Daniel Prueba',
  telefonos: [
    { id: 10, telefono: '3764123456', principal: true },
    { id: 11, telefono: '1161234567', principal: false },
  ],
};

export const CLI_MARIA: any = {
  id: 2, nombre: 'María Gómez',
  telefonos: [{ id: 20, telefono: '3815550000', principal: true }],
};

/** Copia profunda de un cliente, para que un test no mute el fixture de otro. */
export function clonarCliente(c: any): any {
  return { ...c, telefonos: (c.telefonos || []).map((t: any) => ({ ...t })) };
}

/** Turno atendido de Ganancias. El real llega ya filtrado por estado. */
export function ganancia(over: Record<string, any> = {}): any {
  return {
    id: 1, fecha: '2026-10-02', hora: '10:00:00', hora_inicio: '10:00:00',
    estado: 'atendido', metodo_pago: 'Efectivo',
    servicio_id: 1, servicio_nombre: 'Lavado simple', servicio_nombre_final: null,
    precio: 12000, precio_final: null, empleado_id: 1,
    ...over,
  };
}

export { SupabaseService };
