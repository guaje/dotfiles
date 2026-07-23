export interface HudAdapter {
  activate(): Promise<boolean>;
  dispose(): void;
}
