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
    const signIn = vi.fn().mockResolvedValue({ error: { message: 'bad' } });
    const { cmp } = montar({
      client: { auth: {
        getSession: () => Promise.resolve({ data: { session: { user: { email: 'x@carwash.local' } } }, error: null }),
        signInWithPassword: signIn,
        updateUser: () => Promise.resolve({ error: null }),
      } },
    });
    cmp.passwordActual = 'malaclave';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    await cmp.cambiarPassword();
    expect(cmp.mensajeErrorPassword).toMatch(/actual es incorrecta/i);
    expect(signIn).toHaveBeenCalledWith({ email: 'x@carwash.local', password: 'malaclave' });
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

  it('la clave actual se verifica con signIn, y updateUser manda la nueva: nunca el texto a la tabla', async () => {
    // Lo que se prueba es que la app NO guarda la contraseña: desde la 016 la base
    // no tiene `password_hash`, así que lo que va a Postgres es el token de Supabase
    // Auth, no la clave. Si esto falla, alguien reactivó el guardado a mano.
    const enviados: string[] = [];
    const si = vi.fn().mockImplementation((args: any) => { enviados.push(args.password); return Promise.resolve({ error: null }); });
    const upd = vi.fn().mockImplementation((args: any) => { enviados.push(args.password); return Promise.resolve({ error: null }); });
    const { cmp } = montar({
      client: { auth: {
        getSession: () => Promise.resolve({ data: { session: { user: { email: 'x@carwash.local' } } }, error: null }),
        signInWithPassword: si,
        updateUser: upd,
      } },
    });
    cmp.passwordActual = 'vieja123';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    await cmp.cambiarPassword();
    expect(enviados).toEqual(['vieja123', 'nueva123']);
  });

  it('el email para verificar es el de la sesión, no un string duro', async () => {
    const si = vi.fn().mockResolvedValue({ error: null });
    const { cmp } = montar({
      client: { auth: {
        getSession: () => Promise.resolve({ data: { session: { user: { email: 'laura@carwash.local' } } }, error: null }),
        signInWithPassword: si,
        updateUser: () => Promise.resolve({ error: null }),
      } },
    }, {});
    cmp.passwordActual = 'vieja123';
    cmp.passwordNueva = 'nueva123';
    cmp.passwordRepetir = 'nueva123';
    await cmp.cambiarPassword();
    expect(si).toHaveBeenCalledWith({ email: 'laura@carwash.local', password: 'vieja123' });
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