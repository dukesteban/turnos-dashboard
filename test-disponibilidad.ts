import { jornadaCubre, turnoTocadoPorAusencia, normalizarJornada, textoAusencia } from './src/app/utils/fechas';

let ok = 0, fail = 0;
function check(nombre: string, real: any, esperado: any) {
  const bien = JSON.stringify(real) === JSON.stringify(esperado);
  bien ? ok++ : fail++;
  console.log(`${bien ? 'OK  ' : 'FALLA'}  ${nombre}`);
  if (!bien) console.log(`        esperado ${JSON.stringify(esperado)} / real ${JSON.stringify(real)}`);
}

// Esteban: L,M,J,V (no miércoles, no sábado)  -- dato real de la base
const ESTEBAN = [
  { activo: false, hora_inicio: null, hora_fin: null }, // dom
  { activo: true, hora_inicio: null, hora_fin: null },  // lun
  { activo: true, hora_inicio: null, hora_fin: null },  // mar
  { activo: false, hora_inicio: null, hora_fin: null }, // mie  <-- no trabaja
  { activo: true, hora_inicio: null, hora_fin: null },  // jue
  { activo: true, hora_inicio: null, hora_fin: null },  // vie
  { activo: false, hora_inicio: null, hora_fin: null }, // sab
];

console.log('--- jornada semanal ---');
check('lunes 10:00 si puede',      jornadaCubre(ESTEBAN, '2026-10-05', '10:00', 60).ok, true);
check('sabado bloqueado',           jornadaCubre(ESTEBAN, '2026-10-03', '10:00', 60).ok, false);
check('sabado: motivo',             jornadaCubre(ESTEBAN, '2026-10-03', '10:00', 60).motivo, 'No trabaja ese día');
check('miercoles bloqueado',        jornadaCubre(ESTEBAN, '2026-10-07', '10:00', 60).ok, false);

console.log('\n--- jornada con horario parcial (sale a las 13) ---');
const MEDIO = normalizarJornada([false, true, true, true, true, true, false]);
MEDIO[1].hora_inicio = '08:00'; MEDIO[1].hora_fin = '13:00';   // lunes hasta 13

check('lunes 09:00 entra',          jornadaCubre(MEDIO, '2026-10-05', '09:00', 60).ok, true);
check('lunes 12:00 +60 entra',      jornadaCubre(MEDIO, '2026-10-05', '12:00', 60).ok, true);
check('lunes 12:30 +60 NO entra',   jornadaCubre(MEDIO, '2026-10-05', '12:30', 60).ok, false);
check('motivo del tope',            jornadaCubre(MEDIO, '2026-10-05', '12:30', 60).motivo, 'Ese día sale a las 13:00');
check('lunes 13:00 no entra',       jornadaCubre(MEDIO, '2026-10-05', '13:00', 60).ok, false);
check('martes sin tope (libre)',    jornadaCubre(MEDIO, '2026-10-06', '22:00', 45).ok, true);

console.log('\n--- ausencias ---');
const VAC = { empleado_id: 8, desde: '2026-12-01', hasta: '2026-12-15', hora_inicio: null, hora_fin: null, tipo: 'vacaciones', motivo: null };
const MEDIODIA = { empleado_id: 8, desde: '2026-12-16', hasta: null, hora_inicio: null, hora_fin: '13:00', tipo: 'medio_jornada', motivo: null };

check('dentro de vacaciones',       !!turnoTocadoPorAusencia([VAC], '2026-12-05', '10:00', 60), true);
check('antes de vacaciones',       !!turnoTocadoPorAusencia([VAC], '2026-11-30', '10:00', 60), false);
check('despues de vacaciones',     !!turnoTocadoPorAusencia([VAC], '2026-12-16', '10:00', 60), false);
check('ultimo dia de vacaciones',  !!turnoTocadoPorAusencia([VAC], '2026-12-15', '10:00', 60), true);

check('medio dia: 09:00 bloqueado', !!turnoTocadoPorAusencia([MEDIODIA], '2026-12-16', '09:00', 60), true);
check('medio dia: 14:00 libre',     !!turnoTocadoPorAusencia([MEDIODIA], '2026-12-16', '14:00', 60), false);
// Con solo hora_fin la ventana bloqueada es [00:00, 13:00): toda la mañana.
check('medio dia: 11:30+60 tmbien', !!turnoTocadoPorAusencia([MEDIODIA], '2026-12-16', '11:30', 60), true);

console.log('\n--- ausencia con franja horaria (reunion 10:00 a 12:00) ---');
const REUNION = { empleado_id: 8, desde: '2026-12-17', hasta: null, hora_inicio: '10:00', hora_fin: '12:00', tipo: 'capacitacion', motivo: null };

check('09:00 antes: libre',         !!turnoTocadoPorAusencia([REUNION], '2026-12-17', '09:00', 60), false);
check('10:00 arranca: bloqueado',   !!turnoTocadoPorAusencia([REUNION], '2026-12-17', '10:00', 60), true);
check('09:30+60 solapa: bloqueado', !!turnoTocadoPorAusencia([REUNION], '2026-12-17', '09:30', 60), true);
check('11:00 dentro: bloqueado',    !!turnoTocadoPorAusencia([REUNION], '2026-12-17', '11:00', 60), true);
check('12:00 termina: libre',       !!turnoTocadoPorAusencia([REUNION], '2026-12-17', '12:00', 60), false);
check('13:00 despues: libre',       !!turnoTocadoPorAusencia([REUNION], '2026-12-17', '13:00', 60), false);
check('otro dia: libre',            !!turnoTocadoPorAusencia([REUNION], '2026-12-18', '10:00', 60), false);

console.log('\n--- texto para la UI ---');
check('texto vacaciones',          textoAusencia(VAC), 'Vacaciones al 15/12');
check('texto medio dia',           textoAusencia(MEDIODIA), 'Sale a las 13:00');

console.log(`\n${ok} OK / ${fail} FALLAS`);
process.exit(fail ? 1 : 0);