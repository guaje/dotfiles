export interface LabeledOption<T> {
  label: string;
  value: T;
}

interface SelectContext {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
  };
}

export async function selectLabeledOption<T>(
  ctx: SelectContext,
  title: string,
  items: readonly LabeledOption<T>[],
): Promise<T | undefined> {
  if (items.length === 0) return undefined;

  const valuesByLabel = new Map<string, T>();
  const labels = items.map((item) => {
    let label = item.label;
    let suffix = 2;
    while (valuesByLabel.has(label)) label = `${item.label} (${suffix++})`;
    valuesByLabel.set(label, item.value);
    return label;
  });

  const selected = await ctx.ui.select(title, labels);
  if (selected === undefined) return undefined;
  return valuesByLabel.get(selected);
}
