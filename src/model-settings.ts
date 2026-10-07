import { models, settingsSchema } from "./schema";
import type { Store } from "./store";
import { ModelCatalogs } from "./model-catalog";
import type { HarnessId } from "./model-picker-schema";

export const nativeSettingsSchema = settingsSchema
  .omit({
    codexModels: true,
    claudeModels: true,
    opencodeModels: true,
    piModels: true,
  })
  .extend({
    opencodeEnabled: settingsSchema.shape.opencodeEnabled.removeDefault(),
    piEnabled: settingsSchema.shape.piEnabled.removeDefault(),
  });
export class ModelSettings {
  constructor(
    private store: Store,
    private catalogs = new ModelCatalogs(),
  ) {}
  async read(harness: HarnessId, refresh = false) {
    const catalog = await this.catalogs.get(harness, refresh);
    return {
      ...catalog,
      harness,
      selected: models(this.store.settings()[`${harness}Models`]),
    };
  }
  async save(harness: HarnessId, selected: string[]) {
    const state = await this.read(harness);
    const allowed = new Set([
      ...state.choices.map((m) => m.id),
      ...state.selected,
    ]);
    if (selected.some((id) => !allowed.has(id)))
      throw new Error(
        "A selected model is no longer in the catalog. Uncheck unavailable models that have not previously been saved.",
      );
    const ids = [...new Set(selected)];
    const text = ids.join(", ");
    if (text.length > 4000)
      throw new Error(
        "Too many models selected. Choose fewer models and save again.",
      );
    this.store.updateSettings({ [`${harness}Models`]: text });
    return { ...state, selected: ids };
  }
}
