import { Component, OnInit } from '@angular/core';
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
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
