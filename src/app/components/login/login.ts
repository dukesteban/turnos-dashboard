import { Component, OnInit, ChangeDetectorRef  } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth';
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
    private auth: AuthService,
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
      const hash = await this.auth.sha256(this.password);
      const registro = await this.supabase.verificarUsuario(this.usuario.trim(), hash);
      if (!registro) {
        this.error = 'Usuario o contraseña incorrectos.';
        this.cargando = false;
        this.cdr.detectChanges();
        return;
      }

      // La sesión guarda el rol y el empleado_id, no solo el nombre. Antes de esto el
      // login guardaba el nombre y la app no volvía a mirar la base, así que no había
      // forma de saber qué puede ver cada uno.
      //
      // `?? 'admin'` como red de seguridad: si una fila de `usuarios` tuviera el rol en
      // NULL o con un valor que no existe, entra como admin en vez de quedarse trabado
      // adentro sin ver nada. Es el lado que menos molesta si algo se rompe, y el
      // CHECK de la base hace que sea casi imposible.
      this.auth.setSesion(
        registro.usuario,
        registro.rol ?? 'admin',
        registro.empleado_id ?? null
      );

      // Si el usuario no tiene permiso para la pantalla de Turnos... no existe ese
      // caso, todos pueden. Pero sí puede pasar que entre por la puerta equivocada: si
      // quedó en `/caja` de una sesión anterior y ahora es empleado, la guard lo
      // manda a Turnos sola. No hace falta hacer nada acá.
      this.router.navigate(['/']);
    } catch (e) {
      this.error = 'Error al iniciar sesión. Intentá de nuevo.';
    }
    this.cargando = false;
  }
}
