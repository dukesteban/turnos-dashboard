import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { Directive, ElementRef, HostListener, forwardRef } from '@angular/core';
import { formatearMoneda, monedaParaEditar, parsearMoneda } from './moneda';

/**
 * Input de plata con formato argentino: `$1.000,00`.
 *
 * El problema que resuelve: los montos eran `<input type="number">`, asi que en
 * pantalla se veia `0` o `1000`, sin separador de miles, sin simbolo y sin
 * decimales. En una pantalla de caja, donde hay ocho montos juntos, `1000` y
 * `100000` se parecen demasiado: el que carga tiene que contar los ceros a ojo.
 * Con `$1.000,00` y `$100.000,00` la diferencia se ve de un vistazo.
 *
 * Por que `type="text"` y no `number`: un input numerico NO acepta `$` ni puntos,
 * el navegador los descarta. El formateo tiene que vivir en el valor mostrado,
 * no en el valor del modelo.
 *
 * El modelo sigue siendo un NUMBER. El formato es solo de pantalla:
 *   · al entrar al campo se ve el numero pelado (`1000,5`), que es lo que se
 *     puede editar con el teclado
 *   · al salir se pinta `$1.000,50`
 *
 * La conversion la hace este `ControlValueAccessor`, asi que `[(ngModel)]` sigue
 * funcionando igual: lo que se escribe vuelve al modelo como numero y lo que el
 * modelo cambia se pinta formateado.
 */
@Directive({
  selector: 'input[appMoneda]',
  standalone: true,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => MonedaDirective),
      multi: true,
    },
  ],
})
export class MonedaDirective implements ControlValueAccessor {
  /** El valor como numero. Es lo que se manda al modelo. */
  private valor = 0;

  /** `true` mientras el campo tiene el foco: ahi NO se reformatea. */
  private escribiendo = false;

  private alCambiar: (valor: number) => void = () => {};
  private alTocar: () => void = () => {};

  constructor(private el: ElementRef<HTMLInputElement>) {}

  // ─── Lo que pide `ControlValueAccessor` ───

  writeValue(valor: any): void {
    const n = Number(valor);
    this.valor = Number.isFinite(n) ? n : 0;
    // Si el usuario esta escribiendo, el input manda: reformatear aca le
    // moveria el cursor a mitad de la palabra.
    if (!this.escribiendo) this.pintar();
  }

  registerOnChange(fn: (valor: number) => void): void {
    this.alCambiar = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.alTocar = fn;
  }

  // ─── Lo que pasa cuando el usuario toca el campo ───

  @HostListener('focus')
  alEntrar(): void {
    this.escribiendo = true;
    const input = this.el.nativeElement;
    // Cero se muestra vacio: si no, hay que borrar el "0" antes de escribir.
    input.value = monedaParaEditar(this.valor);
    input.select();
  }

  @HostListener('blur')
  alSalir(): void {
    this.escribiendo = false;
    this.alTocar();
    this.pintar();
  }

  @HostListener('input')
  alEscribir(): void {
    const n = parsearMoneda(this.el.nativeElement.value);
    this.valor = n;
    this.alCambiar(n);
  }

  /** Pinta `$1.000,00` en el input. */
  private pintar(): void {
    this.el.nativeElement.value = formatearMoneda(this.valor);
  }
}
