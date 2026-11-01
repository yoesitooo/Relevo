import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Api, Sesion } from '../api';

@Component({
  selector: 'app-entrar',
  imports: [FormsModule],
  template: `
    <main class="entrar">
      <h1>Relevo</h1>
      <p class="sub">Panel de webhooks</p>
      <form (ngSubmit)="entrar()">
        <label for="clave">Clave de administración</label>
        <input id="clave" name="clave" type="password" [(ngModel)]="clave" autocomplete="current-password" required />
        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        }
        <button type="submit" [disabled]="cargando() || !clave">{{ cargando() ? 'Verificando…' : 'Entrar' }}</button>
      </form>
    </main>
  `,
})
export class Entrar {
  private api = inject(Api);
  private sesion = inject(Sesion);
  private router = inject(Router);
  clave = '';
  cargando = signal(false);
  error = signal(inject(ActivatedRoute).snapshot.queryParamMap.get('motivo') === 'clave' ? 'La sesión expiró o la clave cambió.' : '');

  async entrar(): Promise<void> {
    this.cargando.set(true);
    this.error.set('');
    this.sesion.guardar(this.clave.trim());
    try {
      await this.api.fuentes(); // comprueba la clave
      await this.router.navigate(['/eventos']);
    } catch (e) {
      this.sesion.guardar(null);
      this.error.set(e instanceof HttpErrorResponse && e.status === 401 ? 'Clave incorrecta.' : 'No se pudo conectar con la API.');
    } finally {
      this.cargando.set(false);
    }
  }
}
