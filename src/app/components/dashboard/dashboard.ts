import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SupabaseService } from '../../services/supabase';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.html',
  styleUrls: ['./dashboard.scss']
})
export class DashboardComponent implements OnInit {
  turnosHoy: any[] = [];
  todosTurnos: any[] = [];
  totalIngresos = 0;
  totalClientes = 0;
  turnosPendientes = 0;

  constructor(private supabase: SupabaseService) {}

  async ngOnInit() {
    await this.cargarDatos();
  }

  async cargarDatos() {
    this.turnosHoy = await this.supabase.getTurnosHoy();
    this.todosTurnos = await this.supabase.getTurnos();
    const stats = await this.supabase.getEstadisticas();
    
    this.totalIngresos = stats
      .filter(t => t.estado === 'confirmado')
      .reduce((sum, t) => sum + (t.precio || 0), 0);
    
    this.totalClientes = new Set(
      this.todosTurnos.map(t => t.cliente_telefono)
    ).size;
    
    this.turnosPendientes = this.todosTurnos
      .filter(t => t.estado === 'pendiente').length;
  }

  async cambiarEstado(id: number, estado: string) {
    await this.supabase.updateEstadoTurno(id, estado);
    await this.cargarDatos();
  }
}
