import { describe, it, expect } from "vitest";
import { standardValidate, StandardSchemaV1 } from "./standard";

describe("standardValidate", () => {
  it("passes valid input through", async () => {
    const schema: StandardSchemaV1<number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value: value as number }),
        types: { input: 0 as number, output: 0 as number },
      },
    };
    const result = await standardValidate(schema, 42);
    expect(result).toBe(42);
  });

  it("throws when validation returns issues", async () => {
    const schema: StandardSchemaV1<number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({
          issues: [{ message: "must be a number" }, { message: "required" }],
        }),
      },
    };
    await expect(standardValidate(schema, "bad" as any)).rejects.toThrow(
      "must be a number",
    );
  });

  it("handles async validate function", async () => {
    const schema: StandardSchemaV1<number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value: unknown) => ({ value: value as number }),
        types: { input: 0 as number, output: 0 as number },
      },
    };
    const result = await standardValidate(schema, 99);
    expect(result).toBe(99);
  });

  it("handles async validation failure", async () => {
    const schema: StandardSchemaV1<number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => ({
          issues: [{ message: "async failure" }],
        }),
      },
    };
    await expect(standardValidate(schema, 1)).rejects.toThrow("async failure");
  });
});
