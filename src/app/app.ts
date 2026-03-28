import { Component, OnInit, HostListener } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
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

  constructor(
    private supabase: SupabaseService,
    private auth: AuthService,
    private router: Router
  ) {}

  private rutas = ['/', '/agenda', '/ganancias', '/clientes', '/configuracion'];
  private touchStartX = 0;
  private touchStartY = 0;

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
}
