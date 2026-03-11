import { Component, OnInit } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { CommonModule } from '@angular/common';
import { SupabaseService } from './services/supabase';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})

export class App implements OnInit {
  nombreNegocio = localStorage.getItem('nombre_negocio') || 'Hola!👋';

  constructor(private supabase: SupabaseService) {}

  async ngOnInit() {
    const config = await this.supabase.getConfiguracion();
    const nombre = config.find((c: any) => c.clave === 'nombre_negocio')?.valor || 'Turnos';
    this.nombreNegocio = nombre;
    localStorage.setItem('nombre_negocio', nombre);
  }
}