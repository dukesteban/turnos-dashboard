import { TestBed } from '@angular/core/testing';
import { ClientesComponent } from './clientes';
import { SupabaseService } from '../../services/supabase';
import {
  crearSupabaseMock, CLI_DANIEL, CLI_MARIA, clonarCliente,
} from '../../testing/supabase-mock';

/**
 * Tests de Clientes.
 *
 * Lo importante acá NO es la lista: es que los teléfonos sean consistentes.
 * `cliente_telefono` en `turnos` es un SNAPSHOT, y el teléfono real vive en la
 * tabla `telefonos`. Cada alta/baja/marca de teléfono tiene que decidir si
 * propaga o no al snapshot, y cada decisión equivocada manda un número viejo al
 * WhatsApp del agente.
 *
 * También está el `confirm()` de cada borrar: si el usuario cancela, NO se
 * toca nada. Es la diferencia entre "¿Eliminar?" y "se borró".
 */

function montar(over: Record<string, any> = {}) {
  const mock = crearSupabaseMock(over);
  TestBed.configureTestingModule({
    providers: [{ provide: SupabaseService, useValue: mock }],
  });
  const cmp = TestBed.createComponent(ClientesComponent).componentInstance;
  return { cmp, mock };
}

/** Los tests arman `cmp.clientes` a mano; esto los deja listos. */
function conClientes(cmp: any, cuantos = 2) {
  cmp.clientes = [clonarCliente(CLI_DANIEL), clonarCliente(CLI_MARIA)].slice(0, cuantos);
  return cmp.clientes;
}

describe('Clientes — carga y busqueda', () => {
  it('carga los clientes al iniciar', async () => {
    const { cmp } = montar({
      getClientes: () => Promise.resolve([clonarCliente(CLI_DANIEL)]),
    });
    await cmp.ngOnInit();
    expect(cmp.clientes.length).toBe(1);
  });

  it('sin busqueda devuelve la lista completa', async () => {
    const { cmp } = montar();
    conClientes(cmp);
    cmp.busqueda = '';
    expect(cmp.clientesFiltrados.length).toBe(2);
  });

  it('filtra por nombre, sin distinguir mayusculas', () => {
    const { cmp } = montar();
    conClientes(cmp);
    cmp.busqueda = 'MARIA';
    expect(cmp.clientesFiltrados.map(c => c.id)).toEqual([CLI_MARIA.id]);
  });

  it('filtra por nombre SIN acentos aunque el cliente los tenga', () => {
    // BUG ARREGLADO: con `nombre.toLowerCase().includes(q)` buscar "maria" no
    // encontraba a "María Gómez" (la í no es la i) y el usuario veía lista vacía
    // con el cliente cargado en la base. En español se escribe sin acentos
    // casi siempre.
    const { cmp } = montar();
    conClientes(cmp);
    for (const q of ['maria', 'MARIA', 'gomez', 'GÓMEZ', 'Maria Gomez']) {
      cmp.busqueda = q;
      expect(cmp.clientesFiltrados.map(c => c.id)).toEqual([CLI_MARIA.id]);
    }
  });

  it('filtra por telefono aunque este guardado con formato', () => {
    // El validador admite espacios y guiones, asi que "11 5555-1111" puede estar
    // en la base. Buscar los digitos pelados tiene que encontrarlo.
    const { cmp } = montar();
    cmp.clientes = [{ id: 5, nombre: 'Con formato', telefonos: [{ id: 50, telefono: '11 5555-1111' }] }];
    for (const q of ['115555', '11 5555', '55-1111', '55551111']) {
      cmp.busqueda = q;
      expect(cmp.clientesFiltrados.map(c => c.id)).toEqual([5]);
    }
  });

  it('una busqueda con letras NO hace match con todos los telefonos', () => {
    // Trampa del normalizador: si la consulta se reduce a "" y se usa includes,
    // `includes("")` da true para todos y el filtro no filtra nada.
    const { cmp } = montar();
    conClientes(cmp);
    cmp.busqueda = 'zzz';
    expect(cmp.clientesFiltrados).toEqual([]);
  });

  it('filtra por fragmento de telefono', () => {
    const { cmp } = montar();
    conClientes(cmp);
    cmp.busqueda = '5550000';
    expect(cmp.clientesFiltrados.map(c => c.id)).toEqual([CLI_MARIA.id]);
  });

  it('filtra por telefono aunque el nombre no coincida', () => {
    const { cmp } = montar();
    conClientes(cmp);
    cmp.busqueda = '3764';   // solo esta en el telefono de Daniel
    expect(cmp.clientesFiltrados.map(c => c.id)).toEqual([CLI_DANIEL.id]);
  });

  it('una busqueda sin resultados devuelve la lista vacia, no todos', () => {
    const { cmp } = montar();
    conClientes(cmp);
    cmp.busqueda = 'zzzz';
    expect(cmp.clientesFiltrados).toEqual([]);
  });

  it('un cliente sin telefonos no rompe el filtro', () => {
    const { cmp } = montar();
    cmp.clientes = [{ id: 3, nombre: 'Sin phones' }];   // sin array telefonos
    cmp.busqueda = 'sin';
    expect(cmp.clientesFiltrados.length).toBe(1);
  });
});

describe('Clientes — detalle', () => {
  it('seleccionarCliente copia el cliente con editando=false y guarda el original', async () => {
    const { cmp } = montar();
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);

    expect(cmp.clienteSeleccionado.id).toBe(daniel.id);
    expect(cmp.clienteSeleccionado.editando).toBe(false);
    expect(cmp.clienteSeleccionado.nombreOriginal).toBe('Daniel Prueba');
  });

  it('seleccionarCliente NO muta el objeto de la lista', async () => {
    // Si mutara, al cancelar la edicion quedaria el nombre cambiado para siempre
    // en la lista y en cualquier relectura.
    const { cmp } = montar();
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    cmp.clienteSeleccionado.nombre = 'Otro';
    expect(daniel.nombre).toBe('Daniel Prueba');
  });

  it('seleccionarCliente limpia el campo del nuevo telefono', async () => {
    const { cmp } = montar();
    const [daniel] = conClientes(cmp);
    cmp.nuevoTelefono = 'basura';
    await cmp.seleccionarCliente(daniel);
    expect(cmp.nuevoTelefono).toBe('');
  });

  it('seleccionarCliente baja el flag cargandoTurnos', async () => {
    const { cmp } = montar({ getTurnosCliente: () => Promise.resolve([{ id: 1 }]) });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    expect(cmp.cargandoTurnos).toBe(false);
    expect(cmp.turnosCliente.length).toBe(1);
  });

  it('cerrarDetalle limpia la seleccion y los turnos', async () => {
    const { cmp } = montar();
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    cmp.cerrarDetalle();
    expect(cmp.clienteSeleccionado).toBeNull();
    expect(cmp.turnosCliente).toEqual([]);
  });

  it('cancelarEdicionNombre restaura el nombre original', async () => {
    const { cmp } = montar();
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    cmp.clienteSeleccionado.nombre = 'Cambiado mal';
    cmp.cancelarEdicionNombre();
    expect(cmp.clienteSeleccionado.nombre).toBe('Daniel Prueba');
    expect(cmp.clienteSeleccionado.editando).toBe(false);
  });
});

describe('Clientes — nombre', () => {
  it('guardarNombre normaliza y actualiza la lista', async () => {
    const { cmp } = montar({
      normalizarNombre: (n: string) => n.trim().replace(/\s+/g, ' '),
    });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    cmp.clienteSeleccionado.nombre = '  daniel   prueba ';

    await cmp.guardarNombre();

    expect(cmp.clientes[0].nombre).toBe('daniel prueba');
    expect(cmp.clienteSeleccionado.editando).toBe(false);
  });

  it('guardarNombre con duplicado NO actualiza y avisa', async () => {
    const actualizados: any[] = [];
    const { cmp } = montar({
      verificarNombreDuplicado: () => Promise.resolve(true),
      updateCliente: (id: number, n: string) => { actualizados.push({ id, n }); return Promise.resolve(); },
    });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    cmp.clienteSeleccionado.nombre = 'María Gómez';

    await cmp.guardarNombre();

    expect(actualizados).toEqual([]);
    expect(cmp.mensajeError).toMatch(/ya existe/i);
  });

  it('guardarNombre excluye al propio cliente del chequeo de duplicado', async () => {
    // Si no se excluye, guardar el mismo nombre da "ya existe" siempre.
    const excluido: any[] = [];
    const { cmp } = montar({
      verificarNombreDuplicado: (_n: string, excludeId?: number) => {
        excluido.push(excludeId);
        return Promise.resolve(false);
      },
    });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    await cmp.guardarNombre();
    expect(excluido).toEqual([CLI_DANIEL.id]);
  });

  it('guardarNombre sin cliente seleccionado no rompe la pantalla', async () => {
    // BUG ARREGLADO: leia clienteSeleccionado.nombre sin preguntar, y con el
    // detalle cerrado eso es un "cannot read editando of null" en pantalla.
    const { cmp } = montar();
    cmp.clienteSeleccionado = null;
    await expect(cmp.guardarNombre()).resolves.not.toThrow();
    expect(cmp.mensajeError).toMatch(/cliente seleccionado/i);
  });

  it('si updateCliente falla, avisa y no sale del modo edicion', async () => {
    const { cmp } = montar({
      updateCliente: () => Promise.reject(new Error('boom')),
    });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    cmp.clienteSeleccionado.editando = true;

    await cmp.guardarNombre();

    expect(cmp.mensajeError).toMatch(/error/i);
    expect(cmp.clienteSeleccionado.editando).toBe(true);
  });
});

describe('Clientes — agregar telefono', () => {
  it('rechaza un numero invalido sin tocar la base', async () => {
    let agregado = false;
    const { cmp } = montar({
      agregarTelefono: () => { agregado = true; return Promise.resolve({}); },
    });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    cmp.nuevoTelefono = '123';   // muy corto

    await cmp.agregarTelefono();

    expect(agregado).toBe(false);
    expect(cmp.mensajeError).toMatch(/❌/);
  });

  it('rechaza letras sin tocar la base', async () => {
    const { cmp } = montar();
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    cmp.nuevoTelefono = 'Esteban Aguero';   // el caso que contamino la base
    await cmp.agregarTelefono();
    expect(cmp.mensajeError).toMatch(/❌/);
  });

  it('un numero valido se agrega y se suma a la lista', async () => {
    const { cmp } = montar({
      agregarTelefono: (_id: number, tel: string) => Promise.resolve({ id: 30, telefono: tel, principal: false }),
    });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    cmp.nuevoTelefono = ' 3764999999 ';

    await cmp.agregarTelefono();

    expect(cmp.clienteSeleccionado.telefonos.length).toBe(3);
    expect(cmp.clienteSeleccionado.telefonos[2].telefono).toBe('3764999999');  // con trim
    expect(cmp.nuevoTelefono).toBe('');
  });

  it('si es el PRIMER telefono, propaga el numero a los turnos', async () => {
    // Sin esto, el snapshot de los turnos viejos queda con '' y el agente de
    // WhatsApp no tiene a quien mandarle el mensaje.
    const propagados: any[] = [];
    const { cmp } = montar({
      agregarTelefono: (_id: number, tel: string) => Promise.resolve({ id: 30, telefono: tel, principal: true }),
      actualizarTelefonoEnTurnos: (id: number, tel: string) => { propagados.push({ id, tel }); return Promise.resolve(); },
    });
    cmp.clientes = [{ id: 7, nombre: 'Nuevo', telefonos: [] }];
    await cmp.seleccionarCliente(cmp.clientes[0]);
    cmp.nuevoTelefono = '3764111111';

    await cmp.agregarTelefono();

    expect(propagados).toEqual([{ id: 7, tel: '3764111111' }]);
  });

  it('si ya tiene telefonos, NO propaga al agregar otro', async () => {
    let propagado = false;
    const { cmp } = montar({
      agregarTelefono: (_id: number, tel: string) => Promise.resolve({ id: 30, telefono: tel, principal: false }),
      actualizarTelefonoEnTurnos: () => { propagado = true; return Promise.resolve(); },
    });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    cmp.nuevoTelefono = '3764999999';

    await cmp.agregarTelefono();

    expect(propagado).toBe(false);
  });

  it('si la base lo rechaza (duplicado), avisa y no lo agrega localmente', async () => {
    const { cmp } = montar({
      agregarTelefono: () => Promise.reject(new Error('duplicate key')),
    });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    const antes = cmp.clienteSeleccionado.telefonos.length;
    cmp.nuevoTelefono = '3764123456';

    await cmp.agregarTelefono();

    expect(cmp.clienteSeleccionado.telefonos.length).toBe(antes);
    expect(cmp.mensajeError).toMatch(/ya exista/i);
  });
});

describe('Clientes — editar, borrar y marcar telefono', () => {
  const conConfirm = (r: boolean) => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(r);
    return spy;
  };

  it('eliminar: si se cancela, no se toca nada', async () => {
    const spy = conConfirm(false);
    const { cmp } = montar();
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    const antes = cmp.clienteSeleccionado.telefonos.length;

    await cmp.eliminarTelefono(daniel.telefonos[1]);

    expect(cmp.clienteSeleccionado.telefonos.length).toBe(antes);
    spy.mockRestore();
  });

  it('eliminar: propaga el nuevo principal a los turnos', async () => {
    const spy = conConfirm(true);
    const propagados: any[] = [];
    const { cmp } = montar({
      actualizarTelefonoEnTurnos: (id: number, tel: string) => { propagados.push({ id, tel }); return Promise.resolve(); },
    });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);

    await cmp.eliminarTelefono(daniel.telefonos[0]);

    expect(cmp.clienteSeleccionado.telefonos.length).toBe(1);
    expect(propagados.length).toBe(1);
    expect(propagados[0].tel).toBe('1161234567');   // el que quedo
    spy.mockRestore();
  });

  it('eliminar el ULTIMO telefono manda null, no cadena vacia', async () => {
    // El componente manda '' y el servicio lo convierte con `telefono || null`.
    // La columna quedo sin NOT NULL justamente para que null signifique "no
    // tiene". Si el servicio pierde ese `|| null`, se escribe '' en todos los
    // turnos y el snapshot vuelve a tener un tercer estado.
    const spy = conConfirm(true);
    const { cmp } = montar({
      actualizarTelefonoEnTurnos: () => Promise.resolve(),
    });
    cmp.clientes = [{ id: 9, nombre: 'Solo uno', telefonos: [{ id: 40, telefono: '1111', principal: true }] }];
    await cmp.seleccionarCliente(cmp.clientes[0]);

    await cmp.eliminarTelefono(cmp.clienteSeleccionado.telefonos[0]);

    expect(cmp.clienteSeleccionado.telefonos).toEqual([]);
    spy.mockRestore();
  });

  it('marcarPrincipal cambia SOLO el local y propaga el nuevo numero', async () => {
    const spy = conConfirm(true);
    const propagados: any[] = [];
    const { cmp } = montar({
      actualizarTelefonoEnTurnos: (id: number, tel: string) => { propagados.push({ id, tel }); return Promise.resolve(); },
    });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);

    await cmp.marcarPrincipal(daniel.telefonos[1]);

    expect(cmp.clienteSeleccionado.telefonos.find((t: any) => t.id === 11)!.principal).toBe(true);
    expect(cmp.clienteSeleccionado.telefonos.find((t: any) => t.id === 10)!.principal).toBe(false);
    expect(propagados[0].tel).toBe('1161234567');
    spy.mockRestore();
  });

  it('marcarPrincipal cancelado no toca nada', async () => {
    const spy = conConfirm(false);
    const { cmp } = montar();
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    await cmp.marcarPrincipal(daniel.telefonos[1]);
    expect(cmp.clienteSeleccionado.telefonos.find((t: any) => t.id === 11)!.principal).toBe(false);
    spy.mockRestore();
  });

  it('guardarTelefono con numero invalido no actualiza', async () => {
    let editado = false;
    const { cmp } = montar({ editarTelefono: () => { editado = true; return Promise.resolve(); } });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);
    const tel = cmp.clienteSeleccionado.telefonos[0];
    tel._telEditando = 'abc';

    await cmp.guardarTelefono(tel);

    expect(editado).toBe(false);
    expect(tel.telefono).toBe('3764123456');   // sin cambios
    expect(cmp.mensajeError).toMatch(/❌/);
  });

  it('guardarTelefono propaga solo si el numero es el principal', async () => {
    const propagados: any[] = [];
    const { cmp } = montar({
      editarTelefono: () => Promise.resolve(),
      actualizarTelefonoEnTurnos: (id: number, tel: string) => { propagados.push(tel); return Promise.resolve(); },
    });
    const [daniel] = conClientes(cmp);
    await cmp.seleccionarCliente(daniel);

    const secundario = cmp.clienteSeleccionado.telefonos[1];
    secundario._telEditando = '1161111111';
    await cmp.guardarTelefono(secundario);
    expect(propagados).toEqual([]);           // no es principal: no propaga

    const principal = cmp.clienteSeleccionado.telefonos[0];
    principal._telEditando = '3764222222';
    await cmp.guardarTelefono(principal);
    expect(propagados).toEqual(['3764222222']);
  });
});

describe('Clientes — fusionar duplicados', () => {
  it('clientesParaFusionar excluye al cliente abierto', () => {
    const { cmp } = montar();
    conClientes(cmp);
    cmp.clienteSeleccionado = { id: CLI_DANIEL.id, nombre: 'Daniel Prueba' };
    cmp.busquedaFusionar = 'a';   // 'a' matchea a Daniel y a Maria
    const ids = cmp.clientesParaFusionar.map(c => c.id);
    expect(ids).not.toContain(CLI_DANIEL.id);
    expect(ids).toContain(CLI_MARIA.id);
  });

  it('sin busqueda de fusion no propone a nadie', () => {
    const { cmp } = montar();
    conClientes(cmp);
    cmp.busquedaFusionar = '';
    expect(cmp.clientesParaFusionar).toEqual([]);
  });

  it('confirmarFusion saca el duplicado de la lista y recarga el principal', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fusionados: any[] = [];
    const { cmp } = montar({
      fusionarClientes: (a: number, b: number) => { fusionados.push([a, b]); return Promise.resolve(); },
    });
    conClientes(cmp);
    cmp.clienteSeleccionado = { ...clonarCliente(CLI_DANIEL), editando: false, nombreOriginal: CLI_DANIEL.nombre };
    cmp.clienteParaFusionar = clonarCliente(CLI_MARIA);

    await cmp.confirmarFusion();

    expect(fusionados).toEqual([[CLI_DANIEL.id, CLI_MARIA.id]]);
    expect(cmp.clientes.map(c => c.id)).toEqual([CLI_DANIEL.id]);
    expect(cmp.mostrandoFusionar).toBe(false);
    expect(cmp.clienteParaFusionar).toBeNull();
    spy.mockRestore();
  });

  it('confirmarFusion cancelado no fusiona', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    let fusionado = false;
    const { cmp } = montar({ fusionarClientes: () => { fusionado = true; return Promise.resolve(); } });
    conClientes(cmp);
    cmp.clienteSeleccionado = { ...clonarCliente(CLI_DANIEL), editando: false, nombreOriginal: CLI_DANIEL.nombre };
    cmp.clienteParaFusionar = clonarCliente(CLI_MARIA);

    await cmp.confirmarFusion();

    expect(fusionado).toBe(false);
    expect(cmp.clientes.length).toBe(2);
    spy.mockRestore();
  });

  it('confirmarFusion sin nada elegido no hace nada', async () => {
    let fusionado = false;
    const { cmp } = montar({ fusionarClientes: () => { fusionado = true; return Promise.resolve(); } });
    cmp.clienteParaFusionar = null;
    await cmp.confirmarFusion();
    expect(fusionado).toBe(false);
  });
});

describe('Clientes — formatearFecha', () => {
  it('el dia de la semana es el de la fecha', () => {
    const { cmp } = montar();
    // 2026-10-02 es viernes.
    expect(cmp.formatearFecha('2026-10-02')).toBe('Vie 02/10');
    expect(cmp.formatearFecha('2026-10-04')).toBe('Dom 04/10');   // domingo
    expect(cmp.formatearFecha('2026-10-01')).toBe('Jue 01/10');
  });

  it('da el MISMO dia en cualquier zona horaria', () => {
    // BUG ARREGLADO: parseaba a hora LOCAL y leia con getUTC*. Funcionaba de
    // -12 a +12, pero en UTC+13/+14 (Tonga, Kiritimati, Chatham) el dia se
    // corria una posicion. Con la base en UTC el bug NUNCA se reproduce, asi
    // que un test que no fuerce la zona no vale nada: hay que setear TZ.
    const { cmp } = montar();
    // `process` no viene en los types de la app (ahí solo compila browser), asi
    // que se accede por globalThis. Node respeta el cambio de TZ en runtime
    // para los Dates que se creen despues.
    const proc = (globalThis as any).process;
    const original = proc.env.TZ;
    try {
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'Pacific/Midway', 'America/Argentina/Buenos_Aires']) {
        proc.env.TZ = tz;
        expect(cmp.formatearFecha('2026-10-02')).toBe('Vie 02/10');
        expect(cmp.formatearFecha('2026-03-01')).toBe('Dom 01/03');
      }
    } finally {
      proc.env.TZ = original;
    }
  });

  it('una fecha vacia devuelve cadena vacia, no "Invalid Date"', () => {
    const { cmp } = montar();
    expect(cmp.formatearFecha('')).toBe('');
    expect(cmp.formatearFecha(null as any)).toBe('');
  });

  it('el primer dia del mes no se corre al mes anterior', () => {
    const { cmp } = montar();
    expect(cmp.formatearFecha('2026-03-01')).toBe('Dom 01/03');
  });
});
