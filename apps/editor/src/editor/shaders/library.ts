import { useEffect, useSyncExternalStore, type ComponentType } from 'react';

/** Library components by export name (MeshGradient, GodRays, …). */
export type ShaderLibrary = Record<string, ComponentType<Record<string, unknown>>>;

// The effect library (all fragment shaders) is a separate chunk, loaded when a file first needs it.
let library: ShaderLibrary | null = null;
let loading: Promise<ShaderLibrary> | null = null;
const listeners = new Set<() => void>();

export function loadShaderLibrary(): Promise<ShaderLibrary> {
  loading ??= import('@paper-design/shaders-react').then((m) => {
    library = m as unknown as ShaderLibrary;
    for (const l of listeners) l();
    return library;
  });
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useShaderLibrary(): ShaderLibrary | null {
  const lib = useSyncExternalStore(subscribe, () => library);
  useEffect(() => {
    if (!library) void loadShaderLibrary();
  }, []);
  return lib;
}
