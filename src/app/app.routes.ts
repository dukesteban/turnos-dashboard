import { Routes } from '@angular/router';
import { DashboardComponent } from './components/dashboard/dashboard';
import { ConfiguracionComponent } from './components/configuracion/configuracion';
import { AgendaComponent } from './components/agenda/agenda';
import { ClientesComponent } from './components/clientes/clientes';
import { GananciasComponent } from './components/ganancias/ganancias';
import { EmpleadosComponent } from './components/empleados/empleados';
import { LoginComponent } from './components/login/login';
import { authGuard } from './services/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: '', component: DashboardComponent, canActivate: [authGuard] },
  { path: 'agenda', component: AgendaComponent, canActivate: [authGuard] },
  { path: 'ganancias', component: GananciasComponent, canActivate: [authGuard] },
  { path: 'clientes', component: ClientesComponent, canActivate: [authGuard] },
  { path: 'empleados', component: EmpleadosComponent, canActivate: [authGuard] },
  { path: 'configuracion', component: ConfiguracionComponent, canActivate: [authGuard] },
  { path: '**', redirectTo: '' }
];
