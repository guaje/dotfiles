import type { HudItem, HudItemHandle, HudItemUpdate } from "./types.ts";

export const HUD_REGISTRY_SYMBOL = Symbol.for("pi.hud.registry.v1");

type Registry = { items: Map<string, HudItem>; listeners: Set<() => void> };

function getRegistry(): Registry {
  const global = globalThis as typeof globalThis & { [HUD_REGISTRY_SYMBOL]?: Registry };
  return global[HUD_REGISTRY_SYMBOL] ??= { items: new Map(), listeners: new Set() };
}

function key(owner: string, id: string) { return `${owner}:${id}`; }
function notify() { for (const listener of getRegistry().listeners) listener(); }

export function onHudChange(listener: () => void) {
  getRegistry().listeners.add(listener);
  return () => getRegistry().listeners.delete(listener);
}

export function registerHudItem(item: HudItem){
  const registry = getRegistry();
  const itemKey = key(item.owner, item.id);
  const registered: HudItem = { ...item, order: item.order ?? 0, visible: item.visible ?? true };
  registry.items.set(itemKey, registered);
  notify();
  let disposed = false;
  const update = (patch: HudItemUpdate) => {
    if (disposed || registry.items.get(itemKey) !== registered) return;
    Object.assign(registered, patch);
    notify();
  };
  return {
    update,
    show: () => update({ visible: true }),
    hide: () => update({ visible: false }),
    dispose: () => { if (!disposed) { disposed = true; if (registry.items.get(itemKey) === registered) { registry.items.delete(itemKey); notify(); } } },
  };
}

export function hudItems() {
  return [...getRegistry().items.values()]
    .filter((item) => item.visible !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || key(a.owner, a.id).localeCompare(key(b.owner, b.id)));
}

export function clearHudOwner(owner: string) {
  let changed = false;
  for (const [itemKey, item] of getRegistry().items) if (item.owner === owner) { getRegistry().items.delete(itemKey); changed = true; }
  if (changed) notify();
}
