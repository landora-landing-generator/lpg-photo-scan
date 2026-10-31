import { describe, expect, it } from "vitest";

const { PROVIDERS, drawModelsFor } = require("../src/main/providers");

describe("drawing model lists", () => {
  it("every service lists its default model and no model twice", () => {
    for (const p of Object.values(PROVIDERS)) {
      const ids = p.drawModels.map((m) => m.id);
      expect(ids).toContain(p.drawModel);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("no text, vector or upscale model among the presets", () => {
    for (const p of Object.values(PROVIDERS)) {
      for (const m of p.drawModels) expect(m.id).not.toMatch(/deepseek|vector|upscale|-edit$|auto/);
    }
  });

  it("removed presets go away, added models come after the presets", () => {
    const list = drawModelsFor("polza", {
      removed: ["qwen/image-2"],
      added: [{ id: "acme/painter", label: "Painter" }],
    });
    expect(list.some((m) => m.id === "qwen/image-2")).toBe(false);
    expect(list.at(-1)).toEqual({ id: "acme/painter", label: "Painter" });
    expect(drawModelsFor("polza")).toHaveLength(PROVIDERS.polza.drawModels.length);
  });
});
