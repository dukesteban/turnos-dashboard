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
 *   · `cambiarPassword`: el límite de 2 cambios por día vive en localStorage, o
 *     sea que es del lado del cliente y se puede saltar. Los tests fijan el
 *     comportamiento, no lo hacen seguro.
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

describe('Configuración — contraseña', () => {
  const hoy = () => new Date().toLocaleDateString('en-CA');
  const conCambios = (n: number) => localStorage.setItem('pwd_cambios', JSON.stringify({ fecha: hoy(), count: n }));

  beforeEach(() => localStorage.removeItem('pwd_cambios'));

  it('sin cambios hoy, el contador arranca en 0', () => {
    const { cmp } = montar();
    expect(cmp.cambiosHoy).toBe(0);
  });

  it('los cambios de AYER no cuentan para hoy', () => {
    localStorage.setItem('pwd_cambios', JSON.stringify({ fecha: '2020-01-01', count: 2 }));
    const { cmp } = montar();
    expect(cmp.cambiosHoy).toBe(0);
  });

  it('bloquea el TERCER cambio del dia', async () => {
    conCambios(2);
    const { cmp, mock } = montar();
    cmp.passwordActual = 'vieja123';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    await cmp.cambiarPassword();
    expect(cmp.mensajeErrorPassword).toMatch(/2 veces/i);
    expect(mock.llamadas).not.toContain('cambiarPassword');
  });

  it('pide los tres campos', async () => {
    const { cmp } = montar();
    cmp.passwordActual = 'vieja';
    cmp.passwordNueva = '';
    cmp.passwordRepetir = 'x';
    await cmp.cambiarPassword();
    expect(cmp.mensajeErrorPassword).toMatch(/complet/i);
  });

  it('rechaza si la nueva no coincide con la repetida', async () => {
    const { cmp } = montar();
    cmp.passwordActual = 'vieja123';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'otra999';
    await cmp.cambiarPassword();
    expect(cmp.mensajeErrorPassword).toMatch(/coincide/i);
  });

  it('exige 6 caracteres como minimo', async () => {
    const { cmp } = montar();
    cmp.passwordActual = 'vieja123';
    cmp.passwordNueva = '12345';
    cmp.passwordRepetir = '12345';
    await cmp.cambiarPassword();
    expect(cmp.mensajeErrorPassword).toMatch(/6 caracteres/i);
  });

  it('verifica la contraseña ACTUAL antes de cambiar nada', async () => {
    const { cmp, mock } = montar({ verificarUsuario: () => Promise.resolve(false) });
    cmp.passwordActual = 'malaclave';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    await cmp.cambiarPassword();
    expect(cmp.mensajeErrorPassword).toMatch(/actual es incorrecta/i);
    expect(mock.llamadas).not.toContain('cambiarPassword');
  });

  it('el cambio exitoso limpia los campos y suma al contador', async () => {
    const { cmp } = montar();
    cmp.passwordActual = 'vieja123';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    await cmp.cambiarPassword();
    expect(cmp.passwordActual).toBe('');
    expect(cmp.passwordNueva).toBe('');
    expect(cmp.passwordRepetir).toBe('');
    expect(cmp.cambiosHoy).toBe(1);
    expect(cmp.mensajePassword).toBe('✅ Contraseña cambiada. Te queda 1 cambio hoy.');
  });

  it('hashea antes de mandar: a la base viaja el hash, no la contraseña', async () => {
    const enviados: string[] = [];
    const { cmp } = montar({
      verificarUsuario: (_u: string, h: string) => { enviados.push(h); return Promise.resolve(true); },
      cambiarPassword: (_u: string, h: string) => { enviados.push(h); return Promise.resolve(); },
    }, {
      // El `sha256` va en el mock de AuthService, no en el de Supabase: son
      // servicios distintos. Pasarlo por el primer objeto no hacia nada.
      // Ademas devuelve un valor opaco: si devolviera el texto plano envuelto en
      // algo, el `not.toContain('vieja123')` de abajo daria falso positivo.
      sha256: (s: string) => Promise.resolve(s === 'vieja123' ? 'HASH_ACTUAL' : 'HASH_NUEVA'),
    });
    cmp.passwordActual = 'vieja123';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    await cmp.cambiarPassword();
    expect(enviados).toEqual(['HASH_ACTUAL', 'HASH_NUEVA']);
    expect(enviados).not.toContain('vieja123');
    expect(enviados).not.toContain('nueva123');
  });

  it('el hash se calcula con el usuario logged-in, no con uno hardcodeado', async () => {
    const usuarios: string[] = [];
    const { cmp } = montar({
      verificarUsuario: (u: string) => { usuarios.push(u); return Promise.resolve(true); },
    }, { getUsuario: () => 'laura' });
    cmp.passwordActual = 'vieja123';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    await cmp.cambiarPassword();
    expect(usuarios).toEqual(['laura']);
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
