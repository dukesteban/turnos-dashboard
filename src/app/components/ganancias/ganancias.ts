import { Component, OnInit, ChangeDetectorRef, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';
import { nombreMes } from '../../utils/fechas';

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

  horaInicio = 8;
  horaFin = 20;

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarHorarios();
    await this.cargarDatos();
    this.cdr.detectChanges();
  }

  async cargarHorarios() {
    const horarios = await this.supabase.getHorarios();
    const activos = (horarios || []).filter((h: any) => h.activo);
    if (activos.length > 0) {
      const inicios = activos.map((h: any) => parseInt((h.hora_inicio || '08:00').split(':')[0], 10));
      const fines = activos.map((h: any) => {
        const parts = (h.hora_fin || '20:00').split(':');
        const hora = parseInt(parts[0], 10);
        const min = parseInt(parts[1] || '0', 10);
        return min > 0 ? hora + 1 : hora;
      });
      this.horaInicio = Math.min(...inicios);
      this.horaFin = Math.max(...fines);
    }
  }

  async cargarDatos() {
    this.cargando = true;
    const { desde, hasta } = this.getRango();
    this.turnos = await this.supabase.getGanancias(desde, hasta);
    this.cargando = false;
    this.cdr.detectChanges();
    this.scrollToHoy();
  }

  get totalPorMetodoPago(): { metodo: string, cantidad: number, total: number }[] {
    const mapa: { [key: string]: { cantidad: number, total: number } } = {};
    this.turnos.forEach(t => {
      const metodo = t.metodo_pago || 'Sin registrar';
      if (!mapa[metodo]) mapa[metodo] = { cantidad: 0, total: 0 };
      mapa[metodo].cantidad++;
      mapa[metodo].total += Number(t.precio_final || t.precio) || 0;
    });
    return Object.entries(mapa)
      .map(([metodo, v]) => ({ metodo, ...v }))
      .sort((a, b) => b.total - a.total);
  }

  getRango(): { desde: string, hasta: string } {
    const formatLocal = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    if (this.vista === 'dia') {
      const d = formatLocal(this.fechaActual);
      return { desde: d, hasta: d };
    } else {
      const y = this.fechaActual.getFullYear();
      const m = this.fechaActual.getMonth();
      const desde = formatLocal(new Date(y, m, 1));
      const hasta = formatLocal(new Date(y, m + 1, 0));
      return { desde, hasta };
    }
  }

  // STATS
  get totalGanancias(): number {
    return this.turnos.reduce((sum, t) => sum + (Number(t.precio_final || t.precio) || 0), 0);
  }

  get totalAtendidos(): number {
    return this.turnos.length;
  }

  //get ticketPromedio(): number {
    //return this.totalAtendidos > 0 ? Math.round(this.totalGanancias / this.totalAtendidos) : 0;
  //}

  get metodoPagoMasUsado(): string {
    if (!this.turnos.length) return '-';
    const conteo: { [key: string]: number } = {};
    this.turnos.forEach(t => {
      // Sin `|| 'Sin registrar'` la clave del objeto era la string "null" y la
      // tarjeta mostraba literalmente la palabra null. `totalPorMetodoPago` ya
      // lo hacia bien; este getters se habia quedado atras.
      const metodo = t.metodo_pago || 'Sin registrar';
      conteo[metodo] = (conteo[metodo] || 0) + 1;
    });
    return Object.entries(conteo).sort((a, b) => b[1] - a[1])[0][0];
  }

  get servicioMasVendido(): string {
    if (!this.turnos.length) return '-';
    const conteo: { [key: string]: number } = {};
    this.turnos.forEach(t => {
      const nombre = t.servicio_nombre_final || t.servicio_nombre || 'Sin especificar';
      conteo[nombre] = (conteo[nombre] || 0) + 1;
    });
    return Object.entries(conteo).sort((a, b) => b[1] - a[1])[0][0];
  }

  // GRAFICO
  get datosGrafico(): { label: string, total: number, cantidad: number }[] {
    if (this.vista === 'dia') {
      const horas: { [key: string]: { total: number, cantidad: number } } = {};
      let minH = this.horaInicio;
      let maxH = this.horaFin;
      this.turnos.forEach(t => {
        const h = parseInt(t.hora_inicio?.slice(0, 2) || t.hora?.slice(0, 2) || '0', 10);
        if (h && h < minH) minH = h;
        if (h && h > maxH) maxH = h;
      });
      for (let h = minH; h <= maxH; h++) {
        horas[`${h}:00`] = { total: 0, cantidad: 0 };
      }
      this.turnos.forEach(t => {
        const h = parseInt(t.hora_inicio?.slice(0, 2) || t.hora?.slice(0, 2) || '0', 10);
        const key = `${h}:00`;
        if (horas[key]) {
          horas[key].total += (t.estado === 'atendido' && t.precio_final ? t.precio_final : t.precio) || 0;
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
          dias[idx].total += (t.estado === 'atendido' && t.precio_final ? t.precio_final : t.precio) || 0;
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
    this.turnos.filter(t => t.estado === 'atendido').forEach(t => {
      const nombre = t.servicio_nombre_final || t.servicio_nombre;
      const precio = t.precio_final || t.precio;
      if (!mapa[nombre]) mapa[nombre] = { cantidad: 0, total: 0 };
      mapa[nombre].cantidad++;
      mapa[nombre].total += Number(precio) || 0;
    });
    return Object.entries(mapa)
      .map(([nombre, v]) => ({ nombre, ...v }))
      .sort((a, b) => b.total - a.total);
  }

  // NAVEGACION
  navegar(dir: number) {
    if (this.vista === 'dia') {
      const d = new Date(this.fechaActual);
      d.setDate(d.getDate() + dir);
      this.fechaActual = d;
    } else {
      // `setMonth` con overflow salta de mes: 31 de enero + 1 mes es "31 de
      // febrero", que Date normaliza a 3 de marzo. El usuario ve un salto de
      // enero a marzo. Se clampea al ultimo dia del mes destino.
      const y = this.fechaActual.getFullYear();
      const m = this.fechaActual.getMonth() + dir;
      const ultimoDestino = new Date(y, m + 1, 0).getDate();
      const dia = Math.min(this.fechaActual.getDate(), ultimoDestino);
      this.fechaActual = new Date(y, m, dia);
    }
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
      return nombreMes(this.fechaActual.getMonth(), this.fechaActual.getFullYear());
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
      }
    }, 800);
  }

  irADia(label: string) {
    if (this.vista !== 'mes') return;
    const dia = parseInt(label);
    const nueva = new Date(this.fechaActual.getFullYear(), this.fechaActual.getMonth(), dia);
    this.fechaActual = nueva;
    this.vista = 'dia';
    this.cargarDatos();
  }
}
