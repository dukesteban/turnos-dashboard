import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink, RouterLinkActive, NavigationEnd } from '@angular/router';
import { ClientesComponent } from '../clientes/clientes';
import { EmpleadosComponent } from '../empleados/empleados';
import { ProveedoresComponent } from './proveedores';
import { filter } from 'rxjs';

/**
 * Shell de "Personas": las tres pantallas de gente, en pestañas.
 *
 * **Clientes, Empleados y Proveedores bajo un mismo grupo.** Son las tres fichas
 * con las que trabaja el lavadero: a quién se le lava el auto, quién atiende y
 * quién nos vende los insumos. Tenirlas separadas en la barra y una sola
 * Proveedores escondida dentro de Caja (que es plata, no personas) las
 * escondía.
 *
 * Las pestañas son RUTAS HIJAS (`/personas/clientes`), no un estado del
 * componente. Eso trae tres cosas gratis:
 *   - `/clientes` y `/empleados`, que ya estaban guardadas, redirigen y siguen
 *     funcionando (ver `app.routes.ts`).
 *   - El boton "atras" del celu salta a la pestana anterior en vez de salir de
 *     Personas.
 *   - Copiar y pegar la URL abre la pestana correcta.
 *
 * Los hijos van dentro de `*ngIf`, no en un `<router-outlet>`: cada pantalla
 * carga sus datos en su `ngOnInit` y no usa el Router, así que no hay nada que
 * preservar entre navegaciones. Montar la pestaña es lo que recarga los datos,
 * igual que antes de que existiera este grupo.
 */
@Component({
  selector: 'app-personas',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    RouterLinkActive,
    ClientesComponent,
    EmpleadosComponent,
    ProveedoresComponent,
  ],
  templateUrl: './personas.html',
  styleUrls: ['./personas.scss'],
})
export class PersonasComponent {
  /**
   * Qué pestaña está activa, según la URL.
   *
   * Se lee del `Router` y no de un campo propio: si el shell guardara el estado
   * y alguien llegara por URL directa (o por un link guardado a
   * `/personas/empleados`), el botón marcado sería el equivocado.
   */
  tabActual = 'clientes';

  /** Las tres pestañas que existen. Cualquier otra cosa en la URL no es una. */
  private static readonly TABS = ['clientes', 'empleados', 'proveedores'];

  constructor(private router: Router) {
    this.syncTab();
    // Cada navegación cambia la pestaña activa. Sin esto, el botón marcado se
    // queda en la anterior.
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => this.syncTab());
  }

  /**
   * Lee la pestaña de la URL y, si no existe, se corrige sola.
   *
   * La ruta es `personas/:tab?`, así que `/personas/quemonda` matchea y abre el
   * shell. Sin este recorte, los tres getters serían falsos y se vería un
   * espacio en blanco sin explicación. Con `replaceUrl` además queda la URL
   * limpia, para que copiar y compartir mande a la pestaña correcta.
   */
  private syncTab() {
    const m = this.router.url.match(/\/personas\/(\w+)/);
    const pedido = m ? m[1] : 'clientes';
    if (!PersonasComponent.TABS.includes(pedido)) {
      this.tabActual = 'clientes';
      this.router.navigate(['/personas/clientes'], { replaceUrl: true });
      return;
    }
    this.tabActual = pedido;
  }

  get esClientes(): boolean   { return this.tabActual === 'clientes'; }
  get esEmpleados(): boolean { return this.tabActual === 'empleados'; }
  get esProveedores(): boolean { return this.tabActual === 'proveedores'; }
}