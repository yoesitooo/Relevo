import { DatePipe, JsonPipe } from '@angular/common';
import { Component, inject, input, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, DetalleEvento, Envio } from '../api';

@Component({
  selector: 'app-detalle-evento',
  imports: [RouterLink, DatePipe, JsonPipe],
  template: `
    <header class="barra">
      <a routerLink="/eventos">← Eventos</a>
    </header>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    @if (detalle(); as d) {
      <h1><code>{{ d.evento.tipo }}</code></h1>
      <dl class="datos">
        <dt>Fuente</dt><dd>{{ d.evento.fuente }}</dd>
        <dt>Recibido</dt><dd>{{ d.evento.recibido_en | date: 'dd/MM/yyyy HH:mm:ss' }}</dd>
        <dt>ID del proveedor</dt><dd><code>{{ d.evento.id_externo }}</code></dd>
      </dl>

      <h2>Entregas</h2>
      @for (e of d.envios; track e.id) {
        <article class="envio">
          <header>
            <span class="url">{{ e.destino_url }}</span>
            <span [class]="'estado ' + e.estado">{{ e.estado }}</span>
            <button (click)="reenviar(e)" [disabled]="reenviando() === e.id">
              {{ reenviando() === e.id ? 'Reenviando…' : 'Reenviar' }}
            </button>
          </header>
          <ol class="linea">
            @for (i of e.intentos_detalle; track i.numero) {
              <li [class.ok]="i.codigo_http !== null && i.codigo_http < 300">
                <strong>Intento {{ i.numero }}</strong>{{ i.manual ? ' (manual)' : '' }} ·
                {{ i.hecho_en | date: 'dd/MM HH:mm:ss' }} ·
                {{ i.codigo_http ?? 'sin respuesta' }} · {{ i.duracion_ms }} ms
                @if (i.error) { · <span class="error-texto">{{ i.error }}</span> }
              </li>
            } @empty {
              <li>Aún sin intentos.</li>
            }
          </ol>
          @if (e.estado === 'pendiente' && e.intentos > 0) {
            <p class="nota">Próximo intento: {{ e.proximo_intento_en | date: 'dd/MM HH:mm:ss' }}</p>
          }
        </article>
      } @empty {
        <p>Esta fuente no tenía destinos cuando llegó el evento.</p>
      }

      <h2>Cuerpo recibido</h2>
      <pre>{{ d.evento.cuerpo | json }}</pre>
    } @else if (!error()) {
      <p>Cargando…</p>
    }
  `,
})
export class DetalleEventoPagina implements OnInit {
  private api = inject(Api);
  readonly id = input.required<string>();
  detalle = signal<DetalleEvento | null>(null);
  reenviando = signal<string | null>(null);
  error = signal('');

  async ngOnInit(): Promise<void> {
    await this.cargar();
  }

  async cargar(): Promise<void> {
    try {
      this.detalle.set(await this.api.evento(this.id()));
    } catch {
      this.error.set('No se encontró el evento.');
    }
  }

  async reenviar(e: Envio): Promise<void> {
    this.reenviando.set(e.id);
    try {
      await this.api.reenviar(e.id);
      await this.cargar();
    } catch {
      this.error.set('No se pudo reenviar.');
    } finally {
      this.reenviando.set(null);
    }
  }
}
