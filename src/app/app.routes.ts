import { Routes } from '@angular/router';
import { DashboardComponent } from './components/dashboard/dashboard';
import { ConfiguracionComponent } from './components/configuracion/configuracion';
import { AgendaComponent } from './components/agenda/agenda';
import { CajaComponent } from './components/caja/caja';
import { PersonasComponent } from './components/personas/personas';
import { LoginComponent } from './components/login/login';
import { authGuard } from './services/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: '', component: DashboardComponent, canActivate: [authGuard] },
  { path: 'agenda', component: AgendaComponent, canActivate: [authGuard] },
  // La ruta se llama `/ganancias` y no `/caja` a propósito: cambiar la URL
  // rompe los links guardados y el historial del navegador. Lo que cambia es lo
  // que la pantalla MUESTRA, que ahora es la caja completa (ingresos + pagos +
  // compras), no solo los ingresos.
  { path: 'ganancias', component: CajaComponent, canActivate: [authGuard] },
  // Alias para quien ya sepa que se llama Caja.
  { path: 'caja', component: CajaComponent, canActivate: [authGuard] },

  // ── PERSONAS ──────────────────────────────────────────────────────
  // Clientes, Empleados y Proveedores bajo un mismo grupo, en pestañas.
  //
  // `:tab?` es un PARÁMETRO de una sola ruta, no rutas hijas. Al principio
  // usé rutas hijas (`path: 'personas'` con `children`) y no funcionó: sin
  // `children`, el segmento que sobra (`clientes`) no tiene dónde ir, la ruta no
  // matchea y caía al `{ path: '**' }` que manda a Turnos.
  //
  // Con un parámetro opcional las tres pestañas son URLs reales (`/personas/
  // empleados`): se pueden compartir, "atrás" salta de pestaña, y `/clientes`
  // redirige bien.
  { path: 'personas', redirectTo: '/personas/clientes', pathMatch: 'full' },
  { path: 'personas/:tab?', component: PersonasComponent, canActivate: [authGuard] },

  // Las dos rutas viejas siguen funcionando: redirigen a su pestaña. Nadie tiene
  // que cambiar un link guardado ni un acceso directo.
  //
  // `ClientesComponent` y `EmpleadosComponent` ya NO se enrutan acá: los
  // renderiza el shell de Personas con `*ngIf`. Es por eso que no se importan
  // arriba.
  { path: 'clientes', redirectTo: '/personas/clientes' },
  { path: 'empleados', redirectTo: '/personas/empleados' },

  { path: 'configuracion', component: ConfiguracionComponent, canActivate: [authGuard] },
  { path: '**', redirectTo: '' }
];