import { Component, OnInit, ChangeDetectorRef, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';

@Component({
  selector: 'app-ganancias',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ganancias.html',
  styleUrls: ['./ganancias.scss']
})
export class GananciasComponent implements OnInit {
  vista: 'dia' | 'mes' = 'mes';
  fechaActual = new Date();
  turnos: any[] = [];
  cargando = false;
  @ViewChild('graficoRef') graficoRef!: ElementRef;

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarDatos();
  }

  async cargarDatos() {
    this.cargando = true;
    const { desde, hasta } = this.getRango();
    this.turnos = await this.supabase.getGanancias(desde, hasta);
    this.cargando = false;
    this.cdr.detectChanges();
    this.scrollToHoy();
  }

  getRango(): { desde: string, hasta: string } {
    if (this.vista === 'dia') {
      const d = this.fechaActual.toISOString().split('T')[0];
      return { desde: d, hasta: d };
    } else {
      const y = this.fechaActual.getFullYear();
      const m = this.fechaActual.getMonth();
      const desde = new Date(y, m, 1).toISOString().split('T')[0];
      const hasta = new Date(y, m + 1, 0).toISOString().split('T')[0];
      return { desde, hasta };
    }
  }

  // STATS
  get totalGanancias(): number {
    return this.turnos.reduce((sum, t) => sum + (t.precio || 0), 0);
  }

  get totalAtendidos(): number {
    return this.turnos.length;
  }

  get ticketPromedio(): number {
    return this.totalAtendidos > 0 ? Math.round(this.totalGanancias / this.totalAtendidos) : 0;
  }

  get servicioMasVendido(): string {
    if (!this.turnos.length) return '-';
    const conteo: { [key: string]: number } = {};
    this.turnos.forEach(t => {
      conteo[t.servicio_nombre] = (conteo[t.servicio_nombre] || 0) + 1;
    });
    return Object.entries(conteo).sort((a, b) => b[1] - a[1])[0][0];
  }

  // GRAFICO
  get datosGrafico(): { label: string, total: number, cantidad: number }[] {
    if (this.vista === 'dia') {
      const horas: { [key: string]: { total: number, cantidad: number } } = {};
      for (let h = 8; h <= 20; h++) {
        horas[`${h}:00`] = { total: 0, cantidad: 0 };
      }
      this.turnos.forEach(t => {
        const h = parseInt(t.hora_inicio?.slice(0, 2) || t.hora?.slice(0, 2) || '0');
        const key = `${h}:00`;
        if (horas[key]) {
          horas[key].total += t.precio || 0;
          horas[key].cantidad++;
        }
      });
      return Object.entries(horas).map(([label, v]) => ({ label, ...v }));
    } else {
      const y = this.fechaActual.getFullYear();
      const m = this.fechaActual.getMonth();
      const diasEnMes = new Date(y, m + 1, 0).getDate();
      
      const dias: { label: string, total: number, cantidad: number }[] = [];
      for (let d = 1; d <= diasEnMes; d++) {
        dias.push({ label: String(d).padStart(2, '0'), total: 0, cantidad: 0 });
      }
      
      this.turnos.forEach(t => {
        const d = parseInt(t.fecha?.slice(8, 10));
        const idx = d - 1;
        if (dias[idx]) {
          dias[idx].total += t.precio || 0;
          dias[idx].cantidad++;
        }
      });
      
      return dias;
    }
  }

  get maxGrafico(): number {
    return Math.max(...this.datosGrafico.map(d => d.total), 1);
  }

  get totalPorServicio(): { nombre: string, cantidad: number, total: number }[] {
    const mapa: { [key: string]: { cantidad: number, total: number } } = {};
    this.turnos.forEach(t => {
      if (!mapa[t.servicio_nombre]) mapa[t.servicio_nombre] = { cantidad: 0, total: 0 };
      mapa[t.servicio_nombre].cantidad++;
      mapa[t.servicio_nombre].total += t.precio || 0;
    });
    return Object.entries(mapa)
      .map(([nombre, v]) => ({ nombre, ...v }))
      .sort((a, b) => b.total - a.total);
  }

  // NAVEGACION
  navegar(dir: number) {
    const d = new Date(this.fechaActual);
    if (this.vista === 'dia') {
      d.setDate(d.getDate() + dir);
    } else {
      d.setMonth(d.getMonth() + dir);
    }
    this.fechaActual = d;
    this.cargarDatos();
  }

  irHoy() {
    this.fechaActual = new Date();
    this.cargarDatos();
  }

  cambiarVista(v: 'dia' | 'mes') {
    this.vista = v;
    this.fechaActual = new Date();
    this.cargarDatos();
  }

  get tituloFecha(): string {
    if (this.vista === 'dia') {
      const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
      const d = String(this.fechaActual.getDate()).padStart(2,'0');
      const m = String(this.fechaActual.getMonth()+1).padStart(2,'0');
      return `${dias[this.fechaActual.getDay()]} ${d}/${m}`;
    } else {
      const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
      return `${meses[this.fechaActual.getMonth()]} ${this.fechaActual.getFullYear()}`;
    }
  }

  scrollToHoy() {
    if (this.vista !== 'mes') return;
    setTimeout(() => {
      const grafico = this.graficoRef?.nativeElement;
      if (!grafico) return;
      const hoy = new Date().getDate();
      const inner = grafico.querySelector('.grafico-inner') as HTMLElement;
      if (!inner) return;
      const barras = inner.querySelectorAll('.barra-col');
      const idx = hoy - 1;
      if (barras[idx]) {
        const el = barras[idx] as HTMLElement;
        grafico.scrollLeft = el.offsetLeft - grafico.clientWidth / 2 + el.clientWidth / 2;
        console.log('scroll', grafico.scrollLeft, el.offsetLeft, grafico.clientWidth);
      }
    }, 800);
  }
}
