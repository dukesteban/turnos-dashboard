import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { App } from './app';
import { SupabaseService } from './services/supabase';
import { AuthService } from './services/auth';
import { crearSupabaseMock, crearAuthMock } from './testing/supabase-mock';

/**
 * Tests del COMPONENTE App: el navbar, los roles y el cambio de contraseña.
 *
 * Los tests de contraseña estaban en `configuracion.spec.ts` y se movieron acá con el
 * popup: la sección de Configuración quedó solo para el admin, y el secretario se
 * quedaba sin forma de cambiar su propia clave. Lo que se prueba no cambió.
 *
 * `SwUpdate` va de mentira porque `App` lo inyecta para el aviso de "hay una versión
 * nueva", que acá no se prueba. Sin él, `createComponent` falla con NG0201.
 *
 * `ApplicationRef` NO se provee a mano: Angular lo usa por dentro para el scheduler de
 * change detection, y un doble sin `subscribe` revienta con "Cannot read properties of
 * undefined (reading 'subscribe')" antes de llegar al primer test. Va el de verdad.
 */

function montar(over: Record<string, any> = {}, authOver: Record<string, any> = {}) {
  const mock = crearSupabaseMock(over);
  const auth = crearAuthMock(authOver);
  TestBed.configureTestingModule({
    // El navbar tiene `<a routerLink>` y `<router-outlet>`, que son directivas que
    // inyectan `Router`. Sin esto, `createComponent` falla con NG0201 antes de llegar
    // al primer test.
    providers: [
      provideRouter([]),
      { provide: SupabaseService, useValue: mock },
      { provide: AuthService, useValue: auth },
      // `isEnabled: false` hace que `escucharVersionNueva` ni se suscriba. El pipe se
      // pone igual porque el constructor lo llama siempre, antes del `if`.
      { provide: SwUpdate, useValue: { isEnabled: false, versionUpdates: { pipe: () => ({ subscribe: () => {} }) } } },
    ],
  });
  const fixture = TestBed.createComponent(App);
  const cmp = fixture.componentInstance;
  return { cmp, fixture, mock, auth };
}

// EL LÍMITE DE 2 CAMBIOS POR DÍA
//
// El contador vive en localStorage, o sea que es del lado del cliente y se puede saltar
// desde la consola. Los tests fijan el COMPORTAMIENTO, no lo hacen seguro. Se mantiene
// igual que antes: el freno sirve para el caso de uso, que es olvidarse la clave y
// cambiarla veinte veces por error.
describe('App - contraseña', () => {
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
    const { cmp, mock } = montar({ verificarUsuario: () => Promise.resolve(null) });
    cmp.passwordActual = 'malaclave';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    await cmp.cambiarPassword();
    expect(cmp.mensajeErrorPassword).toMatch(/actual es incorrecta/i);
    expect(mock.llamadas).not.toContain('cambiarPassword');
  });

  it('el cambio exitoso limpia los campos, suma al contador y deja el aviso a la vista', async () => {
    const { cmp } = montar();
    cmp.passwordActual = 'vieja123';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    cmp.mostrarCambioPassword = true;
    await cmp.cambiarPassword();
    // Los campos se limpian porque el popup SIGUE ABIERTO: si quedara la contraseña
    // nueva escrita adentro, cualquiera que se acerque a la pantalla la lee.
    expect(cmp.passwordActual).toBe('');
    expect(cmp.passwordNueva).toBe('');
    expect(cmp.passwordRepetir).toBe('');
    expect(cmp.cambiosHoy).toBe(1);
    expect(cmp.mensajePassword).toBe('Contraseña cambiada.');
    // Y no se cierra: el "Contraseña cambiada" se muestra DENTRO del popup. Cerrarlo
    // dejaba el mensaje en un componente invisible, o sea que el usuario guardaba y
    // no se enteraba de si salió bien o mal.
    expect(cmp.mostrarCambioPassword).toBe(true);
  });

  it('el popup queda abierto con el aviso y los campos vacíos tras cambiar', async () => {
    // El assertion clave: si el popup se cerrara, el "Contraseña cambiada" caería en
    // un componente invisible y la persona no sabría si el cambio salió bien.
    const { cmp } = montar();
    cmp.abrirCambioPassword();
    cmp.passwordActual = 'vieja123';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    await cmp.cambiarPassword();
    expect(cmp.mostrarCambioPassword).toBe(true);
    expect(cmp.mensajePassword).toBe('Contraseña cambiada.');
    expect(cmp.passwordNueva).toBe('');
  });

  it('el botón Guardar se deshabilita cuando ya hubo 2 cambios hoy', async () => {
    // El `[disabled]` del HTML tiene `cambiosHoy >= 2`. Con 1/2 tiene que quedar
    // habilitado: si no, la segunda clave del día no se podría poner nunca.
    conCambios(1);
    const { cmp, fixture } = montar();
    cmp.abrirCambioPassword();
    cmp.passwordActual = 'vieja123';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    await cmp.cambiarPassword();
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('.popup-acciones .btn-atendido') as HTMLButtonElement;
    expect(cmp.cambiosHoy).toBe(2);
    expect(btn.disabled).toBe(true);
  });

  it('hashea antes de mandar: a la base viaja el hash, no la contraseña', async () => {
    const enviados: string[] = [];
    const { cmp } = montar({
      verificarUsuario: (_u: string, h: string) => { enviados.push(h); return Promise.resolve({ id: 1 }); },
      cambiarPassword: (_u: string, h: string) => { enviados.push(h); return Promise.resolve(); },
    }, {
      // El `sha256` va en el mock de AuthService, no en el de Supabase: son servicios
      // distintos. Pasarlo por el primer objeto no hacía nada. Además devuelve un
      // valor opaco: si devolviera el texto plano envuelto en algo, el
      // `not.toContain('vieja123')` de abajo daría falso positivo.
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
      verificarUsuario: (u: string) => { usuarios.push(u); return Promise.resolve({ id: 1 }); },
    }, { getUsuario: () => 'laura' });
    cmp.passwordActual = 'vieja123';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    await cmp.cambiarPassword();
    expect(usuarios).toEqual(['laura']);
  });

  it('cerrar el popup limpia los campos y no avisa nada', () => {
    // "Cancelar" tiene que dejar el formulario como estaba: si queda la contraseña
    // nueva escrita adentro y se abre otra vez, se ve.
    const { cmp } = montar();
    cmp.mostrarCambioPassword = true;
    cmp.passwordNueva = 'secreta';
    cmp.mensajeErrorPassword = 'algo';
    cmp.cerrarCambioPassword();
    expect(cmp.mostrarCambioPassword).toBe(false);
    expect(cmp.passwordNueva).toBe('');
    expect(cmp.mensajeErrorPassword).toBe('');
  });
});

// LOS LINKS DEL NAVBAR SEGÚN EL ROL
//
// El navbar es lo primero que ve la persona al abrir la app. Lo que falta ahí y
// aparece de más le dice que puede hacer algo que no puede, y esa es la falla más
// probable.
describe('App - el navbar según el rol', () => {
  it('el admin ve los cinco links', () => {
    const { cmp } = montar({}, { puedeVer: () => true });
    expect(cmp.puedeVerCaja).toBe(true);
    expect(cmp.puedeVerPersonas).toBe(true);
    expect(cmp.puedeVerConfig).toBe(true);
  });

  it('el secretario no ve Config', () => {
    // Configuración tiene horarios de atención, precios y contraseñas.
    const { cmp } = montar({}, { puedeVer: (p: string) => p !== 'configuracion' });
    expect(cmp.puedeVerCaja).toBe(true);
    expect(cmp.puedeVerPersonas).toBe(true);
    expect(cmp.puedeVerConfig).toBe(false);
  });

  it('el empleado no ve ni Caja ni Personas ni Config', () => {
    const { cmp } = montar({}, { puedeVer: (p: string) => p === 'turnos' });
    expect(cmp.puedeVerCaja).toBe(false);
    expect(cmp.puedeVerPersonas).toBe(false);
    expect(cmp.puedeVerConfig).toBe(false);
  });
});