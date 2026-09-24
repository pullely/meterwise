import { suggestBranchEnvMap } from "@web-console-next/components/integrations/branch-map";

describe("suggestBranchEnvMap", () => {
  const envs = [
    { slug: "stage", status: "active" },
    { slug: "prod", status: "active" },
  ];

  it("maps the default branch to the production-looking environment", () => {
    expect(suggestBranchEnvMap("main", envs)).toEqual({ main: "prod" });
  });

  it("falls back to the first active environment", () => {
    expect(suggestBranchEnvMap("main", [{ slug: "dev", status: "active" }])).toEqual({
      main: "dev",
    });
  });

  it("returns an empty map without a default branch or environments", () => {
    expect(suggestBranchEnvMap(null, envs)).toEqual({});
    expect(suggestBranchEnvMap("main", [])).toEqual({});
    expect(suggestBranchEnvMap("main", [{ slug: "old", status: "archived" }])).toEqual({});
  });
});
