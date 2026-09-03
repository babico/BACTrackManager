import { describe, expect, it } from "vitest";
import { seal, open } from "../src/auth/crypto.js";

describe("token encryption", () => {
  it("round-trips arbitrary token strings", () => {
    const key = "ab".repeat(32);
    const sealed = seal(key, "opaque-refresh-token-123");
    expect(sealed).not.toContain("opaque-refresh-token-123");
    expect(open(key, sealed)).toBe("opaque-refresh-token-123");
  });

  it("rejects wrong key", () => {
    const sealed = seal("ab".repeat(32), "x");
    expect(() => open("cd".repeat(32), sealed)).toThrow();
  });
});
