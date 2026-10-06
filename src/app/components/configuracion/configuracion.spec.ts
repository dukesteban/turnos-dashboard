import { TestBed } from '@angular/core/testing';
import { ConfiguracionComponent } from './configuracion';
import { SupabaseService } from '../../services/supabase';
import { AuthService } from '../../services/auth';
import { crearSupabaseMock, crearAuthMock } from '../../testing/supabase-mock';

/**
 * Tests de Configuración.
 *
 * Es la pantalla con más métodos (47) y la que más escribe. Lo que importa:
 *
 *   · `seSuperpone`: dos horarios que se pisan en el mismo día = la agenda
 *     muestra una franja que en realidad no se atiende. Y al revés, un rechazo
 *     de más deja al negocio sin horario un día.
 *   · Los `toggle*` actualizan la fila ANTES de la respuesta y la revierten si
 *     falla. Si se olvida la reversión, la pantalla miente: dice activo lo que
 *     la base no tiene.
 *
 * La parte de contrasenas NO esta aca: se mudo de Configuracion al popup del candado
 * del navbar, porque Configuracion quedo solo para el admin y el secretario se
 * quedaba sin forma de cambiar su propia clave. Los tests viven en app.spec.ts.
 */

function montar(over: Record<string, any> = {}, authOver: Record<string, any> = {}) {
  const mock = crearSupabaseMock(over);
  const auth = crearAuthMock(authOver);
  TestBed.configureTestingModule({
    providers: [
      { provide: SupabaseService, useValue: mock },
      { provide: AuthService, useValue: auth },
    ],
  });
  const cmp = TestBed.createComponent(ConfiguracionComponent).componentInstance;
  return { cmp, mock, auth };
}

const settle = () => new Promise(r => setTimeout(r, 0));

describe('Configuración — carga', () => {
  it('lee la configuracion por clave, no por posicion', async () => {
    const { cmp } = montar({
      getConfiguracion: () => Promise.resolve([
        { clave: 'descripcion', valor: 'Lavadero' },
        { clave: 'nombre_negocio', valor: 'CarWash' },   // vino antes que la descripcion
      ]),
    });
    await cmp.cargarDatos();
    expect(cmp.nombreNegocio).toBe('CarWash');
    expect(cmp.descripcion).toBe('Lavadero');
  });

  it('si faltan claves, usa los defaults', async () => {
    const { cmp } = montar({ getConfiguracion: () => Promise.resolve([]) });
    await cmp.cargarDatos();
    expect(cmp.nombreNegocio).toBe('');
    expect(cmp.horasLimiteCancelacion).toBe(12);
    expect(cmp.recordatorioCuando).toBe('dia_anterior');
    expect(cmp.recordatorioHora).toBe('08:00');
  });

  it('recorta los horarios a HH:MM', async () => {
    // La base guarda '08:00:00' y el <input type="time"> quiere '08:00'.
    const { cmp } = montar({
      getHorarios: () => Promise.resolve([
        { id: 1, dia_semana: 1, hora_inicio: '08:00:00', hora_fin: '20:00:00', activo: true },
      ]),
    });
    await cmp.cargarDatos();
    expect(cmp.horarios[0].hora_inicio).toBe('08:00');
    expect(cmp.horarios[0].hora_fin).toBe('20:00');
  });
});

describe('Configuración — validar y superponer horarios', () => {
  it('un rango es valido si el inicio es menor que el fin', () => {
    const { cmp } = montar();
    expect(cmp.validarHorario('08:00', '20:00')).toBe(true);
  });

  it('inicio igual al fin NO es valido (rango vacio)', () => {
    const { cmp } = montar();
    expect(cmp.validarHorario('08:00', '08:00')).toBe(false);
  });

  it('inicio mayor que el fin NO es valido', () => {
    const { cmp } = montar();
    expect(cmp.validarHorario('20:00', '08:00')).toBe(false);
  });

  it('horas vacias no son validas', () => {
    const { cmp } = montar();
    expect(cmp.validarHorario('', '20:00')).toBe(false);
    expect(cmp.validarHorario('08:00', '')).toBe(false);
  });

  it('compara bien cuando hay que pasarse de la hora (09:59 contra 10:00)', () => {
    // Comparar strings "09:59" < "10:00" da FALSE, que es lo correcto, pero
    // "9:00" < "10:00" tambien. El risco real esta al otro lado: 10:00 vs 9:59.
    const { cmp } = montar();
    expect(cmp.validarHorario('10:00', '9:59')).toBe(false);
    expect(cmp.validarHorario('09:59', '10:00')).toBe(true);
  });

  it('detecta el solapamiento en el mismo dia', () => {
    const { cmp } = montar();
    const existentes = [{ id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: true }];
    expect(cmp.seSuperpone({ id: 99, dia_semana: 1, hora_inicio: '12:00', hora_fin: '18:00', activo: true }, existentes)).toBe(true);
  });

  it('NO detecta solapamiento entre horarios que solo se tocan en el borde', () => {
    // 13:00-18:00 arranco cuando el otro termina: es legal y necesario, si no
    // no se podrian encadenar franjas.
    const { cmp } = montar();
    const existentes = [{ id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: true }];
    expect(cmp.seSuperpone({ id: 99, dia_semana: 1, hora_inicio: '13:00', hora_fin: '18:00', activo: true }, existentes)).toBe(false);
  });

  it('horarios de dias distintos no se solapan', () => {
    const { cmp } = montar();
    const existentes = [{ id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: true }];
    expect(cmp.seSuperpone({ id: 99, dia_semana: 2, hora_inicio: '09:00', hora_fin: '13:00', activo: true }, existentes)).toBe(false);
  });

  it('un horario que se compara consigo mismo no se solapa', () => {
    // Sin el `h.id !== horario.id`, editar un horario siempre se rechazaria a si
    // mismo y no se podria guardar NUNCA un cambio.
    const { cmp } = montar();
    const existentes = [{ id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: true }];
    expect(cmp.seSuperpone({ id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: true }, existentes)).toBe(false);
  });

  it('un horario que se contiene a si mismo no se solapa', () => {
    const { cmp } = montar();
    const existentes = [{ id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '18:00', activo: true }];
    expect(cmp.seSuperpone({ id: 1, dia_semana: 1, hora_inicio: '10:00', hora_fin: '13:00', activo: true }, existentes)).toBe(false);
  });

  it('un horario INACTIVO nunca se solapa (asi se pueden dejar los pisados sin usar)', () => {
    const { cmp } = montar();
    const existentes = [{ id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: true }];
    expect(cmp.seSuperpone({ id: 99, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: false }, existentes)).toBe(false);
  });

  it('un horario inactivo guardado SI solapa contra otro activo', () => {
    const { cmp } = montar();
    const existentes = [{ id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: true }];
    expect(cmp.seSuperpone({ id: 99, dia_semana: 1, hora_inicio: '12:00', hora_fin: '18:00', activo: false }, existentes)).toBe(false);
  });

  it('compara el dia como numero, no como texto', () => {
    // Postgres devuelve dia_semana como number, pero si alguna vez llega "1"
    // como texto, "1" === 1 es false y el solapamiento pasa desapercibido.
    const { cmp } = montar();
    const existentes = [{ id: 1, dia_semana: '1', hora_inicio: '09:00', hora_fin: '13:00', activo: true }];
    expect(cmp.seSuperpone({ id: 99, dia_semana: 1, hora_inicio: '12:00', hora_fin: '18:00', activo: true }, existentes)).toBe(true);
  });
});

describe('Configuración — activar y desactivar', () => {
  it('toggleHorario activa y avisa a la base', async () => {
    const { cmp, mock } = montar();
    cmp.horarios = [{ id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: false }];
    await cmp.toggleHorario(cmp.horarios[0]);
    expect(cmp.horarios[0].activo).toBe(true);
    expect(cmp.horarios[0].guardando).toBe(false);
    expect(mock.llamadas).toContain('updateHorario');
  });

  it('toggleHorario RECHAZA activar algo que se pisa y no toca la base', async () => {
    const { cmp, mock } = montar();
    cmp.horarios = [
      { id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: true },
      { id: 2, dia_semana: 1, hora_inicio: '12:00', hora_fin: '18:00', activo: false },
    ];
    await cmp.toggleHorario(cmp.horarios[1]);
    expect(cmp.horarios[1].activo).toBe(false);      // sigue apagado
    expect(cmp.mensajeErrorHorarios).toMatch(/superpone/i);
    expect(mock.llamadas).not.toContain('updateHorario');
  });

  it('toggleHorario DESACTIVAR siempre se permite, aun si se pisa', () => {
    // Desactivar nunca puede empeorar nada: si no, no habria forma de
    // desactivar un horario que solapa con otro.
    const { cmp, mock } = montar();
    cmp.horarios = [
      { id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: true },
      { id: 2, dia_semana: 1, hora_inicio: '12:00', hora_fin: '18:00', activo: true },
    ];
    return cmp.toggleHorario(cmp.horarios[1]).then(() => {
      expect(cmp.horarios[1].activo).toBe(false);
      expect(mock.llamadas).toContain('updateHorario');
    });
  });

  it('si la base falla, toggleHorario REVIERTE para no mentirle al usuario', async () => {
    const { cmp } = montar({ updateHorario: () => Promise.reject(new Error('boom')) });
    cmp.horarios = [{ id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: false }];
    await cmp.toggleHorario(cmp.horarios[0]);
    expect(cmp.horarios[0].activo).toBe(false);     // vuelve al valor real
    expect(cmp.horarios[0].guardando).toBe(false);
    expect(cmp.mensajeErrorHorarios).toMatch(/no se pudo/i);
  });

  it('doble click rápido no aplica el toggle dos veces', async () => {
    // Sin el guard `guardando`, el segundo click leía el `activo` ya cambiado
    // y lo volvía a cambiar: la fila terminaba como estaba pero la base recibía
    // dos escrituras y el mensaje de error se perdía.
    let llamadas = 0;
    const { cmp } = montar({ updateHorario: () => { llamadas++; return Promise.resolve(); } });
    const h = { id: 1, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: false };
    cmp.horarios = [h];
    const p1 = cmp.toggleHorario(h);
    await cmp.toggleHorario(h);      // segunda BEFORE que la primera termine
    await p1;
    expect(llamadas).toBe(1);
    expect(h.activo).toBe(true);     // NO quedo en false por el doble toggle
  });

  it('toggleServicio y toggleMetodoPago también revierten si la base falla', async () => {
    const { cmp } = montar({
      updateServicio: () => Promise.reject(new Error('boom')),
      updateMetodoPago: () => Promise.reject(new Error('boom')),
    });
    const s = { id: 1, activo: true };
    const m = { id: 1, activo: true };
    await cmp.toggleServicio(s);
    await cmp.toggleMetodoPago(m);
    expect(s.activo).toBe(true);     // restaurado
    expect(m.activo).toBe(true);
  });
});

describe('Configuración — guardar y agregar', () => {
  it('guardarHorario con rango invertido no toca la base', async () => {
    const { cmp, mock } = montar();
    const h: any = { id: 1, dia_semana: 1, hora_inicio: '20:00', hora_fin: '08:00', activo: true };
    await cmp.guardarHorario(h);
    expect(cmp.mensajeErrorHorarios).toMatch(/menor/i);
    expect(mock.llamadas).not.toContain('updateHorario');
  });

  it('guardarHorario detecta el solapamiento contra la base', async () => {
    const { cmp } = montar({
      getHorarios: () => Promise.resolve([
        { id: 2, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: true },
      ]),
    });
    const h: any = { id: 1, dia_semana: 1, hora_inicio: '12:00', hora_fin: '18:00', activo: true };
    await cmp.guardarHorario(h);
    expect(cmp.mensajeErrorHorarios).toMatch(/superpone/i);
    expect(h.editando).not.toBe(false);
  });

  it('guardarHorario corta los segundos antes de mandar', async () => {
    const enviados: any[] = [];
    const { cmp } = montar({
      getHorarios: () => Promise.resolve([]),
      updateHorario: (id: number, d: any) => { enviados.push(d); return Promise.resolve(); },
    });
    const h = { id: 1, dia_semana: 1, hora_inicio: '09:00:00', hora_fin: '13:00:00', activo: true };
    await cmp.guardarHorario(h);
    expect(enviados[0].hora_inicio).toBe('09:00');
    expect(enviados[0].hora_fin).toBe('13:00');
  });

  it('guardarServicio con nombre duplicado NO actualiza', async () => {
    const { cmp, mock } = montar({
      getServicios: () => Promise.resolve([{ id: 2, nombre: 'lavado simple', activo: true }]),
    });
    const s = { id: 1, nombre: 'Lavado Simple', precio: 1, duracion_minutos: 1, activo: true };
    await cmp.guardarServicio(s);
    expect(cmp.mensajeErrorServicios).toMatch(/ya existe/i);
    expect(mock.llamadas).not.toContain('updateServicio');
  });

  it('el chequeo de duplicado de servicio ignora mayusculas y espacios', async () => {
    const { cmp, mock } = montar({
      getServicios: () => Promise.resolve([{ id: 2, nombre: '  Lavado   Simple ', activo: true }]),
    });
    const s = { id: 1, nombre: 'lavado simple', precio: 1, duracion_minutos: 1, activo: true };
    await cmp.guardarServicio(s);
    expect(mock.llamadas).not.toContain('updateServicio');
  });

  it('guardarServicio NO se confunde consigo mismo', async () => {
    const { cmp, mock } = montar({
      getServicios: () => Promise.resolve([{ id: 1, nombre: 'Lavado simple', activo: true }]),
    });
    const s = { id: 1, nombre: 'Lavado simple', precio: 1, duracion_minutos: 1, activo: true };
    await cmp.guardarServicio(s);
    expect(mock.llamadas).toContain('updateServicio');
  });

  it('agregarServicio exige nombre, precio y duracion', async () => {
    const { cmp, mock } = montar();
    cmp.nuevoServicio = { nombre: '', precio: null, duracion_minutos: null };
    await cmp.agregarServicio();
    expect(cmp.mensajeErrorServicios).toMatch(/complet/i);
    expect(mock.llamadas).not.toContain('createServicio');
  });

  it('agregarMetodoPago exige nombre', async () => {
    const { cmp, mock } = montar();
    cmp.nuevoMetodoPago = { nombre: '   ', emoji: '💵' };
    await cmp.agregarMetodoPago();
    expect(cmp.mensajeErrorMetodosPago).toMatch(/obligatorio/i);
    expect(mock.llamadas).not.toContain('createMetodoPago');
  });
});

describe('Configuración — datos del negocio', () => {
  it('rechaza un limite de cancelacion fuera de 1..48', async () => {
    const { cmp, mock } = montar();
    for (const horas of [0, 49, -3, 12.5]) {
      cmp.horasLimiteCancelacion = horas;
      await cmp.guardarConfiguracion();
      expect(cmp.mensajeErrorDatos).toMatch(/entre 1 y 48/i);
    }
    expect(mock.llamadas).not.toContain('upsertConfiguracion');
  });

  it('acepta el borde y guarda las 5 claves', async () => {
    const guardadas: string[] = [];
    const { cmp } = montar({
      upsertConfiguracion: (k: string) => { guardadas.push(k); return Promise.resolve(); },
    });
    cmp.horasLimiteCancelacion = 48;
    await cmp.guardarConfiguracion();
    expect(cmp.mensajeErrorDatos).toBe('');
    expect(guardadas).toEqual([
      'nombre_negocio', 'descripcion', 'horas_limite_cancelacion',
      'recordatorio_cuando', 'recordatorio_hora',
    ]);
  });

  it('guardarConfiguracion sale del modo edicion', async () => {
    const { cmp } = montar();
    cmp.editandoDatos = true;
    await cmp.guardarConfiguracion();
    expect(cmp.editandoDatos).toBe(false);
  });
});

describe('Configuración — dias cerrados', () => {
  it('exige una fecha', async () => {
    const { cmp, mock } = montar();
    cmp.nuevoDiaCerrado = { fecha: '', fecha_hasta: '', motivo: '' };
    await cmp.agregarDiaCerrado();
    expect(cmp.mensajeErrorDiasCerrados).toMatch(/fecha/i);
    expect(mock.llamadas).not.toContain('createDiasCerrados');
  });

  it('rechaza fecha_hasta anterior a fecha', async () => {
    const { cmp, mock } = montar();
    cmp.nuevoDiaCerrado = { fecha: '2026-12-10', fecha_hasta: '2026-12-01', motivo: 'vacaciones' };
    await cmp.agregarDiaCerrado();
    expect(cmp.mensajeErrorDiasCerrados).toMatch(/mayor/i);
    expect(mock.llamadas).not.toContain('createDiasCerrados');
  });

  it('acepta un periodo y lo deja ordenado por fecha', async () => {
    const { cmp } = montar({
      createDiasCerrados: () => Promise.resolve({ id: 9, fecha: '2026-12-05', fecha_hasta: '2026-12-20', motivo: 'vacaciones' }),
    });
    cmp.diasCerrados = [{ id: 1, fecha: '2026-12-25' }];
    cmp.nuevoDiaCerrado = { fecha: '2026-12-05', fecha_hasta: '2026-12-20', motivo: 'vacaciones' };
    await cmp.agregarDiaCerrado();
    expect(cmp.diasCerrados.map((d: any) => d.fecha)).toEqual(['2026-12-05', '2026-12-25']);
  });

  it('cancelarDiaCerrado restaura los valores originales', async () => {
    const { cmp } = montar();
    const dia = {
      fecha: '2026-12-99', fecha_hasta: 'x', motivo: 'typo',
      _fecha_orig: '2026-12-01', _fecha_hasta_orig: '2026-12-02', _motivo_orig: 'feriado',
      editando: true,
    };
    cmp.cancelarDiaCerrado(dia);
    expect(dia.fecha).toBe('2026-12-01');
    expect(dia.motivo).toBe('feriado');
    expect(dia.editando).toBe(false);
  });
});

describe('Configuración — no consulta lo retirado', () => {
  it('nunca toca la tabla `puestos`', async () => {
    const { cmp, mock } = montar();
    await cmp.ngOnInit();
    await settle();
    expect(mock.llamadas.filter((c: string) => /puesto/i.test(c))).toEqual([]);
  });
});