import { Routes } from '@angular/router';
import { DashboardComponent } from './components/dashboard/dashboard';
import { ConfiguracionComponent } from './components/configuracion/configuracion';
import { AgendaComponent } from './components/agenda/agenda';
import { ServiciosComponent } from './components/servicios/servicios';
import { ClientesComponent } from './components/clientes/clientes';

export const routes: Routes = [
  { path: '', component: DashboardComponent },
  { path: 'agenda', component: AgendaComponent },
  { path: 'servicios', component: ServiciosComponent },
  { path: 'clientes', component: ClientesComponent },
  { path: 'configuracion', component: ConfiguracionComponent },
  { path: '**', redirectTo: '' }
];
