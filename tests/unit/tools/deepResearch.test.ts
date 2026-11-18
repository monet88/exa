import { ExaError } from "exa-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeMcpServer } from "../../helpers/fakeMcpServer.js";
import { KeyPool, fingerprintKey } from "../../../src/utils/keyPool.js";

const { ExaMock, exaConstructorMock, requestMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const exaConstructorMock = vi.fn();
  class ExaMock {
    request = requestMock;

    constructor(...args: unknown[]) {
      exaConstructorMock(...args);
    }
  }

  return {
    ExaMock,
    exaConstructorMock,
    requestMock,
  };
});

vi.mock("exa-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("exa-js")>()),
  Exa: ExaMock,
}));

vi.mock("agnost", () => ({
  checkpoint: vi.fn(),
}));

describe("deep researcher KeyPool pinning", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("pins deep_researcher_start researchId and routes deep_researcher_check to that key", async () => {
    vi.useFakeTimers();
    try {
      const { registerDeepResearchStartTool } =
        await import("../../../src/tools/deepResearchStart.js");
      const { registerDeepResearchCheckTool } =
        await import("../../../src/tools/deepResearchCheck.js");
      const server = new FakeMcpServer();
      const keyPool = new KeyPool({
        inlineKeys: ["key-1", "key-2", "key-3"],
        strategy: "round-robin",
        onWarn: () => {},
      });

      registerDeepResearchStartTool(server as any, { keyPool, userProvidedApiKey: true });
      registerDeepResearchCheckTool(server as any, { keyPool, userProvidedApiKey: true });

      requestMock
        .mockRejectedValueOnce(new ExaError("No more credits", 402))
        .mockResolvedValueOnce({ researchId: "res_pinned_1" })
        .mockResolvedValueOnce({ status: "completed", researchId: "res_pinned_1", output: {} });

      const startResult = await server.getTool("deep_researcher_start").handler({
        instructions: "research topic",
      });
      expect((startResult as any).isError).toBeUndefined();
      expect(exaConstructorMock).toHaveBeenNthCalledWith(1, "key-1");
      expect(exaConstructorMock).toHaveBeenNthCalledWith(2, "key-2");

      // Advance round-robin onto key-3, then poll: must still use pinned key-2.
      const checkPromise = server
        .getTool("deep_researcher_check")
        .handler({ researchId: "res_pinned_1" });
      await vi.advanceTimersByTimeAsync(5_000);
      const checkResult = await checkPromise;

      expect((checkResult as any).isError).toBeUndefined();
      expect(exaConstructorMock).toHaveBeenNthCalledWith(3, "key-2");

      // If the pinned key becomes disabled, deep_researcher_check refuses to switch teams.
      keyPool.reportFailure(fingerprintKey("key-2"), { kind: "disabled" });
      const missingKeyPromise = server
        .getTool("deep_researcher_check")
        .handler({ researchId: "res_pinned_1" });
      await vi.advanceTimersByTimeAsync(5_000);
      const missingKeyResult = await missingKeyPromise;

      expect((missingKeyResult as any).isError).toBe(true);
      expect((missingKeyResult as any).content[0].text).toContain("no longer in the pool");
    } finally {
      vi.useRealTimers();
    }
  });
});
