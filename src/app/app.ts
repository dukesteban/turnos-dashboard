import { Component, OnInit, HostListener, ApplicationRef } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';
import { SupabaseService } from './services/supabase';
import { AuthService } from './services/auth';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  nombreNegocio = localStorage.getItem('nombre_negocio') || 'Hola! 👋';

  /**
   * Hay una versión nueva descargada y esperando.
   *
   * POR QUÉ ESTE AVISO EXISTE
   *
   * Cuando se hace `vercel --prod`, los archivos nuevos están en el CDN al
   * instante. Pero la app instalada en el celular NO los usa enseguida: sigue
   * sirviendo la copia que tiene en su caché. Eso es a propósito — el service
   * worker existe para que la app abra sin internet — y es la única fuente de
   * confusión para quien la usa:
   *
   *   · Volver a la app desde el menú del celular -> sigue la versión VIEJA.
   *     El service worker sigue vivo y la caché no cambia.
   *   · Cerrar la app del todo (borrarla del multitarea) y volver a abrir -> se
   *     actualiza sola, sin tocar nada.
   *
   * El service worker se da cuenta de la versión nueva al abrir la app, la
   * descarga, y se queda ESPERANDO. Recién pasa a servirla cuando no queda
   * ninguna pantalla abierta con la versión anterior.
   *
   * Este aviso evita tener que adivinar eso: si hay algo nuevo, aparece una
   * barrita con un botón que lo instala en el momento.
   */
  hayVersionNueva = false;

  constructor(
    private supabase: SupabaseService,
    private auth: AuthService,
    private router: Router,
    private swUpdate: SwUpdate,
    private appRef: ApplicationRef
  ) {
    this.escucharVersionNueva();
  }

  private escucharVersionNueva() {
    // `isEnabled` es false en desarrollo (no hay service worker registrado), y
    // sin este `if` el `versionUpdates` no emite nunca y el aviso jamás aparece.
    if (!this.swUpdate.isEnabled) return;

    this.swUpdate.versionUpdates
      .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => {
        this.hayVersionNueva = true;
        // OBLIGATORIO: `SwUpdate` emite FUERA de la zona de Angular. Sin este
        // `tick()` la variable cambia pero la pantalla no se entera, y el
        // síntoma es un aviso que "no aparece nunca" con el código sin errores.
        this.appRef.tick();
      });
  }

  /**
   * Instalar la versión nueva ahora y recargar.
   *
   * `activateUpdate()` le dice al service worker que tome la versión que estaba
   * esperando. El `location.reload()` es lo que hace que la pantalla pida los
   * archivos nuevos: sin él, la página sigue mostrando la anterior.
   *
   * El `reload` va en un `finally` a propósito: si `activateUpdate()` falla,
   * recargar igual es mejor que dejar al usuario con un aviso que no hace nada.
   */
  async actualizarAhora() {
    try {
      if (this.swUpdate.isEnabled) await this.swUpdate.activateUpdate();
    } catch (e) {
      // Si falla, el reload de abajo lo resuelve igual.
    } finally {
      location.reload();
    }
  }

  /** "Ahora no": esconde el aviso pero deja la actualización para la próxima. */
  despuesActualizar() {
    this.hayVersionNueva = false;
    this.appRef.tick();
  }

  //private rutas = ['/', '/agenda', '/ganancias', '/clientes', '/configuracion'];
  //private touchStartX = 0;
  //private touchStartY = 0;

  async ngOnInit() {
    const config = await this.supabase.getConfiguracion();
    const nombre = config.find((c: any) => c.clave === 'nombre_negocio')?.valor || 'Hola!';
    this.nombreNegocio = nombre;
    localStorage.setItem('nombre_negocio', nombre);
  }

  get isLoggedIn(): boolean {
    return this.auth.isLoggedIn();
  }

  logout() {
    if (!confirm('¿Cerrar sesión?')) return;
    this.auth.logout();
    this.router.navigate(['/login']);
  }

  // DESPLAZAR LATERALMENTE
  /*
  @HostListener('touchstart', ['$event'])
  onTouchStart(e: TouchEvent) {
    this.touchStartX = e.touches[0].clientX;
    this.touchStartY = e.touches[0].clientY;
  }

  @HostListener('touchend', ['$event'])
  onTouchEnd(e: TouchEvent) {
    if (!this.isLoggedIn) return;
    const dx = e.changedTouches[0].clientX - this.touchStartX;
    const dy = e.changedTouches[0].clientY - this.touchStartY;

    // Solo swipe horizontal con suficiente distancia
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;

    const rutaActual = this.router.url.split('?')[0];
    const idx = this.rutas.findIndex(r => r === rutaActual);
    if (idx === -1) return;

    if (dx < 0 && idx < this.rutas.length - 1) {
      // Swipe izquierda → siguiente
      this.router.navigate([this.rutas[idx + 1]]);
    } else if (dx > 0 && idx > 0) {
      // Swipe derecha → anterior
      this.router.navigate([this.rutas[idx - 1]]);
    }
  }
  */
}