import {
  jornadaCubre,
  turnoTocadoPorAusencia,
  normalizarJornada,
  textoAusencia,
  debeMostrarColumna,
  fechaDesdeISO,
  fechaConAnio,
} from './fechas';

/** Esteban: L,M,J,V (no miércoles, no sábado) — dato real de la base. */
const ESTEBAN = [
  { activo: false, hora_inicio: null, hora_fin: null }, // dom
  { activo: true, hora_inicio: null, hora_fin: null },  // lun
  { activo: true, hora_inicio: null, hora_fin: null },  // mar
  { activo: false, hora_inicio: null, hora_fin: null }, // mie  <-- no trabaja
  { activo: true, hora_inicio: null, hora_fin: null },  // jue
  { activo: true, hora_inicio: null, hora_fin: null },  // vie
  { activo: false, hora_inicio: null, hora_fin: null }, // sab
];

const VAC = {
  empleado_id: 8, desde: '2026-12-01', hasta: '2026-12-15',
  hora_inicio: null, hora_fin: null, tipo: 'vacaciones', motivo: null,
};
const MEDIODIA = {
  empleado_id: 8, desde: '2026-12-16', hasta: null,
  hora_inicio: null, hora_fin: '13:00', tipo: 'medio_jornada', motivo: null,
};
const REUNION = {
  empleado_id: 8, desde: '2026-12-17', hasta: null,
  hora_inicio: '10:00', hora_fin: '12:00', tipo: 'capacitacion', motivo: null,
};

describe('jornadaCubre — jornada semanal', () => {
  it('permite el lunes a las 10', () => {
    expect(jornadaCubre(ESTEBAN, '2026-10-05', '10:00', 60).ok).toBe(true);
  });

  it('bloquea el sábado', () => {
    expect(jornadaCubre(ESTEBAN, '2026-10-03', '10:00', 60).ok).toBe(false);
  });

  it('explica por qué bloquea el sábado', () => {
    expect(jornadaCubre(ESTEBAN, '2026-10-03', '10:00', 60).motivo).toBe('No trabaja ese día');
  });

  it('bloquea el miércoles', () => {
    expect(jornadaCubre(ESTEBAN, '2026-10-07', '10:00', 60).ok).toBe(false);
  });
});

describe('jornadaCubre — horario parcial (sale a las 13)', () => {
  // El servicio tiene que ENTRAR COMPLETO, no solo empezar antes del tope.
  const MEDIO = normalizarJornada([false, true, true, true, true, true, false]);
  MEDIO[1].hora_inicio = '08:00';
  MEDIO[1].hora_fin = '13:00';

  it('lunes 09:00 entra', () => {
    expect(jornadaCubre(MEDIO, '2026-10-05', '09:00', 60).ok).toBe(true);
  });

  it('lunes 12:00 + 60 entra', () => {
    expect(jornadaCubre(MEDIO, '2026-10-05', '12:00', 60).ok).toBe(true);
  });

  it('lunes 12:30 + 60 NO entra (terminaría 13:30)', () => {
    expect(jornadaCubre(MEDIO, '2026-10-05', '12:30', 60).ok).toBe(false);
  });

  it('menciona el tope horario en el motivo', () => {
    expect(jornadaCubre(MEDIO, '2026-10-05', '12:30', 60).motivo).toBe('Ese día sale a las 13:00');
  });

  it('lunes 13:00 no entra', () => {
    expect(jornadaCubre(MEDIO, '2026-10-05', '13:00', 60).ok).toBe(false);
  });

  it('martes sin tope: libre incluso a las 22:00', () => {
    expect(jornadaCubre(MEDIO, '2026-10-06', '22:00', 45).ok).toBe(true);
  });
});

describe('turnoTocadoPorAusencia — vacaciones', () => {
  it('detecta dentro del rango', () => {
    expect(turnoTocadoPorAusencia([VAC], '2026-12-05', '10:00', 60)).toBeTruthy();
  });

  it('no toca antes del rango', () => {
    expect(turnoTocadoPorAusencia([VAC], '2026-11-30', '10:00', 60)).toBeNull();
  });

  it('no toca después del rango', () => {
    expect(turnoTocadoPorAusencia([VAC], '2026-12-16', '10:00', 60)).toBeNull();
  });

  it('el último día del rango sigue bloqueado', () => {
    expect(turnoTocadoPorAusencia([VAC], '2026-12-15', '10:00', 60)).toBeTruthy();
  });
});

describe('turnoTocadoPorAusencia — medio día', () => {
  // Con solo hora_fin la ventana bloqueada es [00:00, 13:00): toda la mañana.
  it('bloquea a las 09:00', () => {
    expect(turnoTocadoPorAusencia([MEDIODIA], '2026-12-16', '09:00', 60)).toBeTruthy();
  });

  it('deja libre a las 14:00', () => {
    expect(turnoTocadoPorAusencia([MEDIODIA], '2026-12-16', '14:00', 60)).toBeNull();
  });

  it('bloquea 11:30 + 60 (cruza el tope)', () => {
    expect(turnoTocadoPorAusencia([MEDIODIA], '2026-12-16', '11:30', 60)).toBeTruthy();
  });
});

describe('turnoTocadoPorAusencia — franja horaria (reunión 10:00 a 12:00)', () => {
  it('09:00 antes: libre', () => {
    expect(turnoTocadoPorAusencia([REUNION], '2026-12-17', '09:00', 60)).toBeNull();
  });

  it('10:00 arranca: bloqueado', () => {
    expect(turnoTocadoPorAusencia([REUNION], '2026-12-17', '10:00', 60)).toBeTruthy();
  });

  it('09:30 + 60 solapa: bloqueado', () => {
    expect(turnoTocadoPorAusencia([REUNION], '2026-12-17', '09:30', 60)).toBeTruthy();
  });

  it('11:00 dentro: bloqueado', () => {
    expect(turnoTocadoPorAusencia([REUNION], '2026-12-17', '11:00', 60)).toBeTruthy();
  });

  it('12:00 termina: libre', () => {
    expect(turnoTocadoPorAusencia([REUNION], '2026-12-17', '12:00', 60)).toBeNull();
  });

  it('13:00 después: libre', () => {
    expect(turnoTocadoPorAusencia([REUNION], '2026-12-17', '13:00', 60)).toBeNull();
  });

  it('otro día: libre', () => {
    expect(turnoTocadoPorAusencia([REUNION], '2026-12-18', '10:00', 60)).toBeNull();
  });
});

describe('textoAusencia', () => {
  it('describe las vacaciones con la fecha de fin', () => {
    expect(textoAusencia(VAC)).toBe('Vacaciones al 15/12');
  });

  it('describe el medio día con la hora de corte', () => {
    expect(textoAusencia(MEDIODIA)).toBe('Sale a las 13:00');
  });
});

describe('debeMostrarColumna (regla de columnas de la agenda)', () => {
  // La agenda tiene una columna por EMPLEADO, no por puesto. Estos son los
  // casos que definen si la columna aparece.
  const base = { activo: true, trabaja: true, tieneAusencia: false, tieneTurnosEnRiesgo: false };

  it('el día que trabaja: columna', () => {
    expect(debeMostrarColumna(base)).toBe(true);
  });

  it('día que no trabaja, sin nada más: SIN columna', () => {
    expect(debeMostrarColumna({ ...base, trabaja: false })).toBe(false);
  });

  // Estas dos son las que evitan que un turno quede invisible.
  it('no trabaja pero tiene ausencia: columna rayada', () => {
    expect(debeMostrarColumna({ ...base, trabaja: false, tieneAusencia: true })).toBe(true);
  });

  it('no trabaja pero tiene turnos en riesgo: columna marcada', () => {
    expect(debeMostrarColumna({ ...base, trabaja: false, tieneTurnosEnRiesgo: true })).toBe(true);
  });

  it('inactivo, aunque trabaje ese día: SIN columna', () => {
    expect(debeMostrarColumna({ ...base, activo: false })).toBe(false);
  });

  it('inactivo, aunque tenga turnos: SIN columna', () => {
    expect(debeMostrarColumna({
      activo: false, trabaja: false, tieneAusencia: true, tieneTurnosEnRiesgo: true,
    })).toBe(false);
  });
});

describe('la regla de columna aplicada a una jornada real', () => {
  // Integración: la regla de arriba combinada con los resolvers, sobre las
  // fechas que importan. ESTEBAN = L,M,J,V (no miércoles, no sábado).
  // Diciembre 2026: 05=sáb, 07=lun, 12=sáb.
  const turnoEnSabado = { fecha: '2026-12-05', hora_inicio: '10:00', duracion_minutos: 60 };
  const sabadoSinNada = { fecha: '2026-12-12', hora_inicio: '10:00', duracion_minutos: 60 };
  const vacacionesEnSabado = {
    empleado_id: 8, desde: '2026-12-05', hasta: '2026-12-06',
    hora_inicio: null, hora_fin: null, tipo: 'vacaciones', motivo: null,
  };

  const columna = (fecha: string, ausencias: any[], hayTurnoEnRiesgo: boolean) =>
    debeMostrarColumna({
      activo: true,
      trabaja: jornadaCubre(ESTEBAN, fecha, '00:00', 1).ok,
      tieneAusencia: !!turnoTocadoPorAusencia(ausencias, fecha, '12:00', 1),
      tieneTurnosEnRiesgo: hayTurnoEnRiesgo,
    });

  it('lunes normal: columna', () => {
    expect(columna('2026-12-07', [], false)).toBe(true);
  });

  it('sábado sin nada: no aparece', () => {
    expect(columna(sabadoSinNada.fecha, [], false)).toBe(false);
  });

  it('sábado con vacaciones: aparece rayada', () => {
    expect(columna(turnoEnSabado.fecha, [vacacionesEnSabado], false)).toBe(true);
  });

  it('sábado con turno en riesgo: aparece marcada (el turno NO se oculta)', () => {
    // El turno cae en un día que ESTEBAN no trabaja → está en riesgo.
    const enRiesgo = !jornadaCubre(ESTEBAN, turnoEnSabado.fecha, '10:00', 60).ok;
    expect(enRiesgo).toBe(true);
    expect(columna(turnoEnSabado.fecha, [], enRiesgo)).toBe(true);
  });
});

describe('discriminación jornada vs ausencia (lista "Turnos en riesgo")', () => {
  // Es lo que decide el COLOR del item en la lista de riesgo. Si las dos capas
  // dieran el mismo veredicto, un turno de sábado tapado por vacaciones se
  // mostraría como "no trabaja ese día" y el usuario iría a fixar la jornada.
  //
  // Fechas dentro de VAC (01/12 al 15/12) y de la jornada de ESTEBAN (L,M,J,V).
  // Diciembre 2026: 01 = martes, 05 = sábado.

  it('martes en vacaciones: la jornada lo cubre', () => {
    expect(jornadaCubre(ESTEBAN, '2026-12-01', '10:00', 60).ok).toBe(true);
  });

  it('martes en vacaciones: la ausencia lo tapa', () => {
    expect(turnoTocadoPorAusencia([VAC], '2026-12-01', '10:00', 60)).toBeTruthy();
  });

  it('sábado en vacaciones: la jornada lo rechaza', () => {
    expect(jornadaCubre(ESTEBAN, '2026-12-05', '10:00', 60).ok).toBe(false);
  });

  it('sábado en vacaciones: la ausencia también lo tapa', () => {
    expect(turnoTocadoPorAusencia([VAC], '2026-12-05', '10:00', 60)).toBeTruthy();
  });

  it('lunes de octubre: ninguna capa lo tapa', () => {
    expect(jornadaCubre(ESTEBAN, '2026-10-05', '10:00', 60).ok).toBe(true);
  });

  it('lunes de octubre: sin ausencia que lo toque', () => {
    expect(turnoTocadoPorAusencia([VAC], '2026-10-05', '10:00', 60)).toBeNull();
  });

  it('el motivo de jornada es el de jornada', () => {
    expect(jornadaCubre(ESTEBAN, '2026-12-05', '10:00', 60).motivo).toBe('No trabaja ese día');
  });

  it('el motivo de ausencia es el de la ausencia', () => {
    expect(textoAusencia(turnoTocadoPorAusencia([VAC], '2026-12-01', '10:00', 60)))
      .toBe('Vacaciones al 15/12');
  });
});

describe('fechaDesdeISO', () => {
  // El bug que evita: `new Date('2026-08-15')` se parsea como MEDIANOCHE UTC.
  // En Argentina (UTC-3) eso es el 14/08 a las 21:00 local, o sea el dia
  // ANTERIOR. Sin ningun error: la app muestra el dia anterior y el usuario
  // busca un 15/09 que no aparece.
  //
  // Por eso se comparan los COMPONENTES y no el ISO devuelto: en un runner en
  // UTC las dos formas dan el mismo resultado y el test pasaria teniendo el
  // bug. Los componentes delatan el corrimiento en cualquier timezone.
  it('devuelve el dia exacto, no el anterior', () => {
    const d = fechaDesdeISO('2026-08-15');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(7);      // agosto
    expect(d!.getDate()).toBe(15);
  });

  it('la devuelve a medianoche LOCAL', () => {
    // Si fuera UTC, getHours() daria 3 (o 0 en un runner en UTC) en vez de 0.
    expect(fechaDesdeISO('2026-08-15')!.getHours()).toBe(0);
  });

  it('rechaza lo que no es una fecha, y devuelve null en vez de una Date rota', () => {
    // El input type="date" se vacia si el usuario borra el valor a mano.
    expect(fechaDesdeISO('')).toBeNull();
    expect(fechaDesdeISO(null)).toBeNull();
    expect(fechaDesdeISO(undefined)).toBeNull();
    expect(fechaDesdeISO('ayer')).toBeNull();
    expect(fechaDesdeISO('15/08/2026')).toBeNull();
    expect(fechaDesdeISO('2026-8-15')).toBeNull();      // sin padding
    expect(fechaDesdeISO('2026-08-15T10:00')).toBeNull();   // con hora
  });

  it('rechaza fechas que no existen, en vez de que Date las corra solas', () => {
    // `new Date(2026, 12, 45)` NO tira error: se corre a Feb 14 y termina
    // mostrando una fecha que el usuario nunca eligio.
    expect(fechaDesdeISO('2026-13-45')).toBeNull();
    expect(fechaDesdeISO('2026-00-10')).toBeNull();
    expect(fechaDesdeISO('2026-08-00')).toBeNull();
    expect(fechaDesdeISO('2026-02-31')).toBeNull();     // febrero no tiene 31
  });

  it('acepta los bordes validos', () => {
    expect(fechaDesdeISO('2026-01-31')!.getDate()).toBe(31);   // enero tiene 31
    expect(fechaDesdeISO('2024-02-29')!.getDate()).toBe(29);   // bisiesto
    expect(fechaDesdeISO('2026-02-28')!.getDate()).toBe(28);   // no bisiesto
    expect(fechaDesdeISO('2026-12-31')).not.toBeNull();        // ultimo dia del año
  });
});

// ═════════════════════════════════════════════════════════════════════
// `fechaConAnio`: LA FECHA EN LOS MENSAJES DE BORRADO
//
// Lo que se vio: el cartel de confirmación decía "Borrar el pago del 2026-10-06",
// con el dato crudo de la base, mientras la tabla de al lado mostraba "06/10". Son
// dos formatos de la misma fecha en la misma pantalla.
//
// Esto importa mas de lo que parece: el texto de un `confirm` dice QUE se va a
// borrar y la acción es irreversible. Que muestre la fecha en el formato que nadie
// escribe ni lee hace que haya que traducirla mentalmente para decidir si es la
// correcta.
// ═════════════════════════════════════════════════════════════════════

describe('fechaConAnio', () => {
  it('da dia/mes/anio, que es como las escribe y lee las personas', () => {
    expect(fechaConAnio('2026-10-06')).toBe('06/10/2026');
    expect(fechaConAnio('2026-01-01')).toBe('01/01/2026');
    expect(fechaConAnio('2026-12-31')).toBe('31/12/2026');
  });

  it('no le da vuelta los numeros', () => {
    // El fallo a vigilar: confundir mes y dia, que solo se nota cuando difieren.
    expect(fechaConAnio('2026-10-06')).not.toBe('10/06/2026');
    // 03 de marzo: el dia 3 en un mes de dos digitos, y al reves 30 de marzo.
    expect(fechaConAnio('2026-03-03')).toBe('03/03/2026');
    expect(fechaConAnio('2026-03-30')).toBe('30/03/2026');
  });

  it('acepta que le llegue con hora, como pasa con los timestamps', () => {
    // Un `select *` puede traer "2026-10-06T00:00:00+00:00" si la columna fuera
    // timestamptz. Con el regex, que ancla al principio, matchea la parte de la
    // fecha y descarta la hora.
    expect(fechaConAnio('2026-10-06T00:00:00')).toBe('06/10/2026');
    expect(fechaConAnio('2026-10-06 12:30:00')).toBe('06/10/2026');
  });

  it('no inventa nada con un texto que no es una fecha', () => {
    // El caso de `split('-')`: "no-es-fecha" se desarma en tres partes y sale
    // "fecha/es" o algo pior, un mensaje de borrado mostrando una fecha que nadie
    // eligio. Con regex, lo que no matchea se devuelve tal cual.
    expect(fechaConAnio('no-es-fecha')).toBe('no-es-fecha');
    expect(fechaConAnio('06/10/2026')).toBe('06/10/2026');
    expect(fechaConAnio('20261006')).toBe('20261006');
    expect(fechaConAnio('')).toBe('');
  });

  it('vacio y null devuelven cadena vacia, no "null"', () => {
    // "Borrar el pago del null" es lo que sale si se imprime el valor crudo.
    expect(fechaConAnio(null)).toBe('');
    expect(fechaConAnio(undefined)).toBe('');
    expect(fechaConAnio('')).toBe('');
  });

  it('no corre un dia por la zona horaria', () => {
    // El pipe `date` de Angular aplica la zona del navegador, y con "2026-10-01" en
    // un timezone negativo devuelve 30/09. Este es el fallo que no tira error: solo
    // muestra una fecha que nadie eligio. Se comprueba que NO usa `new Date`.
    expect(fechaConAnio('2026-10-01')).toBe('01/10/2026');
    expect(fechaConAnio('2026-01-01')).toBe('01/01/2026'); // el corrimiento aqui es de un dia entero
  });
});