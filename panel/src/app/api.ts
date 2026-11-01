import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, firstValueFrom, throwError } from 'rxjs';

export type Estado = 'pendiente' | 'entregado' | 'fallido' | 'sin_destinos';

export interface Fuente {
  id: string;
  slug: string;
  nombre: string;
  tipo_firma: string;
  activa: boolean;
  destinos: number;
  url_entrada: string;
}

export interface EventoResumen {
  id: string;
  fuente: string;
  tipo: string;
  recibido_en: string;
  estado_resumen: Estado;
}

export interface Intento {
  numero: number;
  manual: boolean;
  codigo_http: number | null;
  duracion_ms: number;
  error: string | null;
  hecho_en: string;
}

export interface Envio {
  id: string;
  estado: Estado;
  intentos: number;
  proximo_intento_en: string;
  destino_url: string;
  intentos_detalle: Intento[];
}

export interface DetalleEvento {
  evento: { id: string; fuente: string; id_externo: string; tipo: string; cuerpo: unknown; cabeceras: Record<string, string>; recibido_en: string };
  envios: Envio[];
}

const CLAVE_ALMACEN = 'relevo-clave';

/** URL de la API: la define public/config.js (window.RELEVO_API). */
export const urlApi = (): string => ((window as unknown as { RELEVO_API?: string }).RELEVO_API ?? 'http://localhost:3000').replace(/\/$/, '');

@Injectable({ providedIn: 'root' })
export class Sesion {
  /** La clave vive solo en esta pestaña (sessionStorage) y en memoria. */
  readonly clave = signal<string | null>(leer());

  guardar(clave: string | null): void {
    this.clave.set(clave);
    try {
      if (clave) sessionStorage.setItem(CLAVE_ALMACEN, clave);
      else sessionStorage.removeItem(CLAVE_ALMACEN);
    } catch {
      /* sin almacenamiento: la sesión dura lo que la página */
    }
  }
}

function leer(): string | null {
  try {
    return sessionStorage.getItem(CLAVE_ALMACEN);
  } catch {
    return null;
  }
}

/** Agrega la clave a las peticiones a la API y saca al usuario si responde 401. */
export const autorizacion: HttpInterceptorFn = (req, next) => {
  const sesion = inject(Sesion);
  const router = inject(Router);
  const clave = sesion.clave();
  const conClave = clave && req.url.startsWith(urlApi()) ? req.clone({ setHeaders: { Authorization: `Bearer ${clave}` } }) : req;
  return next(conClave).pipe(
    catchError((e: unknown) => {
      if (e instanceof HttpErrorResponse && e.status === 401 && clave) {
        sesion.guardar(null);
        router.navigate(['/entrar'], { queryParams: { motivo: 'clave' } });
      }
      return throwError(() => e);
    }),
  );
};

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  fuentes(): Promise<Fuente[]> {
    return firstValueFrom(this.http.get<Fuente[]>(`${urlApi()}/api/fuentes`));
  }

  eventos(filtros: { fuente?: string; estado?: string; cursor?: string }): Promise<{ items: EventoResumen[]; siguiente: string | null }> {
    const params = Object.fromEntries(Object.entries(filtros).filter(([, v]) => !!v)) as Record<string, string>;
    return firstValueFrom(this.http.get<{ items: EventoResumen[]; siguiente: string | null }>(`${urlApi()}/api/eventos`, { params }));
  }

  evento(id: string): Promise<DetalleEvento> {
    return firstValueFrom(this.http.get<DetalleEvento>(`${urlApi()}/api/eventos/${id}`));
  }

  reenviar(envioId: string): Promise<{ intento: Intento & { exito: boolean } }> {
    return firstValueFrom(this.http.post<{ intento: Intento & { exito: boolean } }>(`${urlApi()}/api/envios/${envioId}/reenviar`, {}));
  }
}
