import { Routes } from '@angular/router';
import { DashboardComponent } from './components/dashboard/dashboard';
import { ConfiguracionComponent } from './components/configuracion/configuracion';
import { AgendaComponent } from './components/agenda/agenda';
import { ClientesComponent } from './components/clientes/clientes';
import { CajaComponent } from './components/caja/caja';
import { EmpleadosComponent } from './components/empleados/empleados';
import { LoginComponent } from './components/login/login';
import { authGuard } from './services/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: '', component: DashboardComponent, canActivate: [authGuard] },
  { path: 'agenda', component: AgendaComponent, canActivate: [authGuard] },
  // La ruta se llama `/ganancias` y no `/caja` a propósito: cambiar la URL
  // rompe los links guardados y el historial del navegador. Lo que cambió es lo
  // que la pantalla MUESTRA, que ahora es la caja completa (ingresos − pagos −
  // compras), no solo los ingresos.
  { path: 'ganancias', component: CajaComponent, canActivate: [authGuard] },
  // Alias para quien ya sepa que se llama Caja.
  { path: 'caja', component: CajaComponent, canActivate: [authGuard] },
  { path: 'clientes', component: ClientesComponent, canActivate: [authGuard] },
  { path: 'empleados', component: EmpleadosComponent, canActivate: [authGuard] },
  { path: 'configuracion', component: ConfiguracionComponent, canActivate: [authGuard] },
  { path: '**', redirectTo: '' }
];
