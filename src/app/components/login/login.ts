import { Component, OnInit, ChangeDetectorRef  } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SupabaseService } from '../../services/supabase';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.html',
  styleUrls: ['./login.scss']
})
export class LoginComponent implements OnInit {
  usuario = '';
  password = '';
  error = '';
  cargando = false;
  nombreNegocio = '';

  constructor(
    private supabase: SupabaseService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    const config = await this.supabase.getConfiguracion();
    this.nombreNegocio = config.find((c: any) => c.clave === 'nombre_negocio')?.valor || 'Bienvenido';
    this.cdr.detectChanges();
  }

  async login() {
    if (!this.usuario.trim() || !this.password.trim()) {
      this.error = 'Completá usuario y contraseña.';
      return;
    }

    this.cargando = true;
    this.error = '';

    try {
      // El usuario escribe un nombre, no un correo: se traduce acá con la función de la
      // base. Si no encuentra la fila en `usuarios`, igual intenta entrar directo: hay
      // casos en los que el email ES el usuario tal cual estaba escrito (cuando el nombre
      // ya era un correo-compatible). Esto evita obligar a que toda la operación pase por
      // la doble consulta.
      let correo = '';
      try {
        const { data } = await this.supabase.client.rpc('correo_de_usuario', { p_usuario: this.usuario.trim() });
        if (typeof data === 'string' && data) correo = data;
      } catch {
        // Si la función no existe o el nombre viene raro, queda el plan B abajo.
      }
      if (!correo) {
        correo = this.usuario.trim();
      }

      const { error } = await this.supabase.client.auth.signInWithPassword({
        email: correo,
        password: this.password,
      });

      if (error) {
        // Mismo mensaje para "el usuario no existe" y "la clave está mal": si distinguiera,
        // la pantalla de login se convierte en una lista de los nombres que hay.
        this.error = 'Usuario o contraseña incorrectos.';
        this.cargando = false;
        this.cdr.detectChanges();
        return;
      }

      // La sesión se arma sola con el `onAuthStateChange` de AuthService. No hace falta
      // guardar `rol` en localStorage a mano: el JWT ya lo trae en `app_metadata`, y
      // eso es lo que la base usa.
      this.router.navigate(['/']);
    } catch (e) {
      this.error = 'Error al iniciar sesión. Intentá de nuevo.';
    }
    this.cargando = false;
  }
}
