import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, EventoResumen, Fuente, Sesion } from '../api';

@Component({
  selector: 'app-eventos',
  imports: [FormsModule, RouterLink, DatePipe],
  template: `
    <header class="barra">
      <h1>Eventos</h1>
      <button class="secundario" (click)="salir()">Salir</button>
    </header>

    <section class="filtros" aria-label="Filtros">
      <label>Fuente
        <select [(ngModel)]="fuente" (ngModelChange)="cargar()" name="fuente">
          <option value="">Todas</option>
          @for (f of fuentes(); track f.id) {
            <option [value]="f.slug">{{ f.nombre }}</option>
          }
        </select>
      </label>
      <label>Estado
        <select [(ngModel)]="estado" (ngModelChange)="cargar()" name="estado">
          <option value="">Todos</option>
          <option value="pendiente">Pendiente</option>
          <option value="entregado">Entregado</option>
          <option value="fallido">Fallido</option>
          <option value="sin_destinos">Sin destinos</option>
        </select>
      </label>
      <button class="secundario" (click)="cargar()">Actualizar</button>
    </section>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    <table>
      <thead><tr><th>Recibido</th><th>Fuente</th><th>Tipo</th><th>Estado</th></tr></thead>
      <tbody>
        @for (e of eventos(); track e.id) {
          <tr>
            <td><a [routerLink]="['/eventos', e.id]">{{ e.recibido_en | date: 'dd/MM/yyyy HH:mm:ss' }}</a></td>
            <td>{{ e.fuente }}</td>
            <td><code>{{ e.tipo }}</code></td>
            <td><span class="estado" [class]="'estado ' + e.estado_resumen">{{ etiqueta[e.estado_resumen] }}</span></td>
          </tr>
        } @empty {
          <tr><td colspan="4" class="vacio">{{ cargando() ? 'Cargando…' : 'No hay eventos con estos filtros.' }}</td></tr>
        }
      </tbody>
    </table>

    @if (siguiente()) {
      <button class="mas" (click)="cargarMas()" [disabled]="cargando()">Cargar más</button>
    }
  `,
})
export class Eventos implements OnInit {
  private api = inject(Api);
  private sesion = inject(Sesion);
  readonly etiqueta: Record<string, string> = { pendiente: 'Pendiente', entregado: 'Entregado', fallido: 'Fallido', sin_destinos: 'Sin destinos' };
  fuentes = signal<Fuente[]>([]);
  eventos = signal<EventoResumen[]>([]);
  siguiente = signal<string | null>(null);
  cargando = signal(false);
  error = signal('');
  fuente = '';
  estado = '';

  async ngOnInit(): Promise<void> {
    this.api.fuentes().then((f) => this.fuentes.set(f)).catch(() => {});
    await this.cargar();
  }

  async cargar(): Promise<void> {
    await this.traer(undefined, false);
  }

  async cargarMas(): Promise<void> {
    await this.traer(this.siguiente() ?? undefined, true);
  }

  private async traer(cursor: string | undefined, agregar: boolean): Promise<void> {
    this.cargando.set(true);
    this.error.set('');
    try {
      const r = await this.api.eventos({ fuente: this.fuente, estado: this.estado, cursor });
      this.eventos.set(agregar ? [...this.eventos(), ...r.items] : r.items);
      this.siguiente.set(r.siguiente);
    } catch {
      this.error.set('No se pudieron cargar los eventos.');
    } finally {
      this.cargando.set(false);
    }
  }

  salir(): void {
    this.sesion.guardar(null);
    location.assign('/entrar');
  }
}
