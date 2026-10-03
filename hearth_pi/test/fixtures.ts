import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
export function offline() {
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    models,
    model: { provider: faux.getModel().provider, modelId: "test" },
  };
}
