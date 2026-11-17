import {lazy, type ComponentType, type LazyExoticComponent} from 'react';

// A hot update can re-evaluate the route table. React treats a new lazy
// wrapper as a different component even when its underlying page is compatible.
declare global {
  interface ImportMeta {
    readonly hot?: {data: {pages?: Map<string, LazyExoticComponent<ComponentType<any>>>}};
  }
}
const pages = import.meta.hot && (import.meta.hot.data.pages ??= new Map());

export function lazyPage<T extends ComponentType<any>>(name: string, load: () => Promise<{default: T}>) {
  const retained = pages?.get(name);
  if (retained) return retained as LazyExoticComponent<T>;
  const page = lazy(load);
  pages?.set(name, page);
  return page;
}
