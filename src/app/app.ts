import { Component, OnInit, HostListener, ApplicationRef, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, RouterLink, RouterLinkActive, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';
import { SupabaseService } from './services/supabase';
import { AuthService } from './services/auth';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommonModule, FormsModule],
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
    private appRef: ApplicationRef,
    private cdr: ChangeDetectorRef
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

  // Lo que el navbar muestra depende del rol. Son getters y no properties porque el
  // rol se cambia con la sesión: al desloguear y entrar como otro, el navbar tiene que
  // cambiar sin recargar la página. Con un property guardado en el constructor, el
  // navbar quedaría con los links del usuario anterior hasta el F5.
  get puedeVerCaja(): boolean {
    return this.auth.puedeVer('caja');
  }

  get puedeVerPersonas(): boolean {
    return this.auth.puedeVer('personas');
  }

  get puedeVerConfig(): boolean {
    return this.auth.puedeVer('configuracion');
  }

  logout() {
    if (!confirm('¿Cerrar sesión?')) return;
    this.auth.logout();
    // Ademas de la ruta, limpiar los datos del usuario anterior. `cargarTurnos` corre
    // en `ngOnInit` del dashboard, asi que sin esto el turno del que se salio queda
    // cargado hasta que se abra la pantalla de nuevo, en el navegador del otro
    // usuario de esta misma PWA.
    this.router.navigate(['/login']);
  }

// ═══════════════════════════════════════════════════════════════════════════
  // CAMBIAR MI CONTRASEÑA
  //
  // Vive acá, en el navbar, y no en Configuración. Antes estaba en un acordeón de esa
  // pantalla, y Configuración quedó solo para el admin cuando llegaron los roles: el
  // secretario se quedó sin forma de cambiar su propia contraseña.
  //
  // Es distinto del candado de la pantalla de Usuarios (que define la clave de OTRO sin
  // pedir la actual): acá se verifica la actual, así que no sirve para cambiarle la
  // clave a nadie más.
  // ═══════════════════════════════════════════════════════════════════════════

  mostrarCambioPassword = false;
  passwordActual = '';
  passwordNueva = '';
  passwordRepetir = '';
  guardandoPassword = false;
  mensajePassword = '';
  mensajeErrorPassword = '';

  /**
   * Cambios de contraseña que ya se hicieron HOY.
   *
   * Se guarda en `localStorage` y no en la base a propósito: es un freno para que
   * alguien que se olvidó de la clave no la cambie veinte veces en un minuto. Si
   * estuviera en la base, el mismo bloqueo andaría para cualquiera que entre desde
   * otro navegador, que es justo lo que NO queremos: un bloqueo es de una persona, no
   * de una contraseña.
   */
  get cambiosHoy(): number {
    try {
      const hoy = new Date().toLocaleDateString('en-CA');
      const parsed = JSON.parse(localStorage.getItem('pwd_cambios') || 'null');
      return parsed && parsed.fecha === hoy ? parsed.count : 0;
    } catch (e) {
      return 0;
    }
  }

  private registrarCambioPassword() {
    const hoy = new Date().toLocaleDateString('en-CA');
    localStorage.setItem('pwd_cambios', JSON.stringify({ fecha: hoy, count: this.cambiosHoy + 1 }));
  }

  abrirCambioPassword() {
    this.mostrarCambioPassword = true;
    this.passwordActual = '';
    this.passwordNueva = '';
    this.passwordRepetir = '';
    this.mensajePassword = '';
    this.mensajeErrorPassword = '';
  }

  cerrarCambioPassword() {
    this.mostrarCambioPassword = false;
    this.passwordActual = '';
    this.passwordNueva = '';
    this.passwordRepetir = '';
    this.mensajeErrorPassword = '';
  }

  async cambiarPassword() {
    this.mensajePassword = '';
    this.mensajeErrorPassword = '';

    if (this.cambiosHoy >= 2) {
      this.mensajeErrorPassword = 'Ya cambiaste la contraseña 2 veces hoy. Mañana.';
      this.cdr.detectChanges();
      return;
    }
    if (!this.passwordActual || !this.passwordNueva || !this.passwordRepetir) {
      this.mensajeErrorPassword = 'Completá los tres campos.';
      this.cdr.detectChanges();
      return;
    }
    if (this.passwordNueva !== this.passwordRepetir) {
      this.mensajeErrorPassword = 'La nueva contraseña no coincide.';
      this.cdr.detectChanges();
      return;
    }
    if (this.passwordNueva.length < 6) {
      this.mensajeErrorPassword = 'La contraseña debe tener al menos 6 caracteres.';
      this.cdr.detectChanges();
      return;
    }

    this.guardandoPassword = true;
    this.cdr.detectChanges();
    try {
      const usuario = this.auth.getUsuario();
      const hashActual = await this.auth.sha256(this.passwordActual);
      const registro = await this.supabase.verificarUsuario(usuario, hashActual);
      if (!registro) {
        this.mensajeErrorPassword = 'La contraseña actual es incorrecta.';
        this.guardandoPassword = false;
        this.cdr.detectChanges();
        return;
      }
      const hashNueva = await this.auth.sha256(this.passwordNueva);
      await this.supabase.cambiarPassword(usuario, hashNueva);
      this.registrarCambioPassword();
      // El popup NO se cierra: el "Contraseña cambiada" vive adentro y si se cerrara
      // nadie lo leería nunca (quedaría un string en un componente invisible). Queda
      // abierto con el aviso verde y los tres campos limpios, para que el cambio se vea
      // y el que quedó con 2/2 de cambios ve por qué no puede volver a guardar.
      this.passwordActual = '';
      this.passwordNueva = '';
      this.passwordRepetir = '';
      this.mensajePassword = 'Contraseña cambiada.';
    } catch (e) {
      this.mensajeErrorPassword = 'No se pudo cambiar la contraseña.';
    }
    this.guardandoPassword = false;
    this.cdr.detectChanges();
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