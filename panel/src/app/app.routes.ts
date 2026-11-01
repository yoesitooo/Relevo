import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
import { Sesion } from './api';
import { DetalleEventoPagina } from './paginas/detalle-evento';
import { Entrar } from './paginas/entrar';
import { Eventos } from './paginas/eventos';

const conClave = () => (inject(Sesion).clave() ? true : inject(Router).parseUrl('/entrar'));

export const routes: Routes = [
  { path: 'entrar', component: Entrar, title: 'Relevo · Entrar' },
  { path: 'eventos', component: Eventos, canActivate: [conClave], title: 'Relevo · Eventos' },
  { path: 'eventos/:id', component: DetalleEventoPagina, canActivate: [conClave], title: 'Relevo · Evento' },
  { path: '', pathMatch: 'full', redirectTo: 'eventos' },
  { path: '**', redirectTo: 'eventos' },
];
