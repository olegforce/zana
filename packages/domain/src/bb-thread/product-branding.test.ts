import { describe, expect, it } from "vitest";
import { builtInThemes, customThemeNameSchema, formatPluginThemeId, isBuiltInThemeId } from "./app-theme.js";
import { PLUGIN_CATALOG_CATEGORIES, pluginCatalogCategory, pluginMarketplaceCollectionSchema } from "./plugin-catalog-category.js";

import { formatRegisteredCodeThemeName } from "./code-theme.js";

describe("product catalogue branding", () => {
  it("uses ZCC in descriptions while keeping stable category identifiers", () => {
    for (const category of PLUGIN_CATALOG_CATEGORIES) {
      expect(pluginCatalogCategory(category.id)).toBe(category);
      expect(`${category.displayName} ${category.description}`).not.toMatch(/\bbb\b/i);
    }
    expect(pluginCatalogCategory("themes-and-appearance")?.description).toContain("ZCC");
    expect(pluginCatalogCategory("unknown")).toBeUndefined();
  });

  it("names registered code themes consistently with bundled palette files", () => {
    expect(formatRegisteredCodeThemeName("nord", "light")).toBe("zcc:nord:light");
    expect(formatRegisteredCodeThemeName("plugin:custom", "dark")).toBe("zcc:plugin:custom:dark");
  });

  it("keeps saved theme identifiers while presenting the current product name", () => {
    for (const theme of builtInThemes) {
      expect(isBuiltInThemeId(theme.id)).toBe(true);
      expect(`${theme.name} ${theme.description}`).not.toMatch(/\bbb\b/i);
    }
    expect(builtInThemes.find((theme) => theme.id === "default")?.description).toContain("ZCC");
    expect(isBuiltInThemeId("unknown")).toBe(false);
  });

  it("rejects duplicate collection membership while accepting existing identifiers", () => {
    const collection = { id: "appearance", displayName: "Appearance", pluginIds: ["theme-a", "theme-b"] };
    expect(pluginMarketplaceCollectionSchema.safeParse(collection).success).toBe(true);
    const invalid = pluginMarketplaceCollectionSchema.safeParse({ ...collection, pluginIds: ["theme-a", "theme-a"] });
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(invalid.error.issues[0]?.path).toEqual(["pluginIds", 1]);
  });

  it("preserves safe custom theme names and plugin palette identities", () => {
    expect(customThemeNameSchema.safeParse("personal-theme").success).toBe(true);
    for (const name of ["default", "nord", ".", "..", "../theme", "theme/other"]) {
      expect(customThemeNameSchema.safeParse(name).success).toBe(false);
    }
    expect(formatPluginThemeId("appearance", "light")).toBe("plugin:appearance:light");
  });
});
