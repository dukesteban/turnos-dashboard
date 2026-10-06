import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService, Rol } from './auth';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  // `asegurarSesion` espera el primer `getSession()`. Sin esto, una sesión válida del
  // localStorage todavía no se leyó, `isLoggedIn()` da false, y la app bota a la
  // persona al login apenas entra. Con el `await` la guard aguanta un rato y deja
  // entrar si la sesión existe.
  await auth.asegurarSesion();
  if (auth.isLoggedIn()) return true;
  router.navigate(['/login']);
  return false;
};

/**
 * Guarda de ROL para una pantalla.
 *
 * Se escribe como un factory (`puedeVer('caja')`) y no como una constante con la
 * pantalla fija, porque el registro de rutas la necesita con el mismo código para
 * `/ganancias`, `/caja`, `/personas` y `/configuracion`.
 *
 * POR QUÉ HAY UNA GUARD Y NO SOLO UN `*ngIf` EN EL NAVBAR
 *
 * Ocultar el link no alcanza: la URL se escribe a mano, o queda en un favorito, o
 * alguien le pasa el link a otro. Con esto, quien no tiene el permiso entra a la
 * pantalla igual de rápido y ve una pantalla vacía.
 *
 * A DONDE MANDA CUANDO NO HAY PERMISIO
 *
 * A Turnos, que todos pueden ver, y no a `/login`: la sesión sigue siendo válida, no
 * es que se haya vencido nada. Mandarlo al login lo obliga a volver a poner la
 * contraseña y parece que la app lobotsé, cuando lo que pasó es que clicked donde no
 * debía.
 */
export function puedeVer(pantalla: 'caja' | 'personas' | 'configuracion' | 'turnos'): CanActivateFn {
  return async () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    await auth.asegurarSesion();
    if (!auth.isLoggedIn()) {
      router.navigate(['/login']);
      return false;
    }
    if (auth.puedeVer(pantalla)) return true;
    router.navigate(['/']);
    return false;
  };
}

/**
 * NO hay un guard "puede escribir en Caja".
 *
 * Se ve natural ponerlo, pero Caja no se divide en rutas: es una sola pantalla
 * donde el secretario VE los tres cuadros y los acordeones, y lo que no puede es tocar
 * los botones de guardar y borrar. Si el guard existiera, el secretario no podria ni
 * entrar a mirar, que no es lo pedido. La escritura se controla con `*ngIf` sobre
 * `auth.puedeEscribirCaja()` en el template, que es donde vive el boton.
 */

export type { Rol };