export type HudZone = "modeRight" | "workspaceRight" | "extensionLine";
export type HudVariant = "full" | "compact" | "icon";
export type HudImportance = "required" | "normal" | "optional";

export type HudTone = "accent" | "success" | "muted" | "warning" | "error" | "text";

export interface HudSegment {
  text: string;
  tone?: HudTone;
}

export interface HudVariants {
  full: HudSegment[];
  compact?: HudSegment[];
  icon?: HudSegment[];
}

export interface HudItem {
  owner: string;
  id: string;
  zone: HudZone;
  order?: number;
  importance: HudImportance;
  variants: HudVariants;
  visible?: boolean;
}

export type HudItemUpdate = Partial<Omit<HudItem, "owner" | "id">>;

export interface HudItemHandle {
  update(update: HudItemUpdate): void;
  show(): void;
  hide(): void;
  dispose(): void;
}
