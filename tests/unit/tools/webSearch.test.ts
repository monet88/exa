import { ExaError } from "exa-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptySearchResponse, searchResponse } from "../../fixtures/exaResponses.js";
import { FakeMcpServer } from "../../helpers/fakeMcpServer.js";
import { KeyPool } from "../../../src/utils/keyPool.js";

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

describe("registerWebSearchTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("sends a sanitized search request and formats highlighted results", async () => {
    const { registerWebSearchTool } = await import("../../../src/tools/webSearch.js");
    const server = new FakeMcpServer();
    requestMock.mockResolvedValue(searchResponse);

    registerWebSearchTool(server as any, {
      exaApiKey: "test-key",
      defaultSearchType: "fast",
      mcpSessionId: "session-123",
    });

    const result = await server.getTool("web_search_exa").handler({
      query: "category:news AI breakthroughs",
      numResults: 2,
    });

    expect(exaConstructorMock).toHaveBeenCalledWith("test-key");
    expect(requestMock).toHaveBeenCalledWith(
      "/search",
      "POST",
      {
        query: "AI breakthroughs",
        type: "fast",
        numResults: 2,
        category: "news",
        contents: {
          highlights: true,
        },
      },
      undefined,
      { "x-exa-integration": "web-search-mcp", "x-exa-mcp-session-id": "session-123" },
    );
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          _meta: { searchTime: 0.42 },
        },
      ],
    });
    expect((result as any).content[0].text).toContain("Title: Result One");
    expect((result as any).content[0].text).toContain("First highlight");
  });

  it("uses an instant default search type when configured", async () => {
    const { registerWebSearchTool } = await import("../../../src/tools/webSearch.js");
    const server = new FakeMcpServer();
    requestMock.mockResolvedValue(searchResponse);

    registerWebSearchTool(server as any, {
      defaultSearchType: "instant",
    });

    await server.getTool("web_search_exa").handler({
      query: "AI breakthroughs",
    });

    expect(requestMock).toHaveBeenCalledWith(
      "/search",
      "POST",
      expect.objectContaining({
        type: "instant",
      }),
      undefined,
      expect.any(Object),
    );
  });

  it("requests dynamic highlights with the Exa-Beta header when the server has them on", async () => {
    const { registerWebSearchTool } = await import("../../../src/tools/webSearch.js");
    const server = new FakeMcpServer();
    requestMock.mockResolvedValue(searchResponse);

    registerWebSearchTool(server as any, { exaApiKey: "test-key", dynamicHighlights: true });

    await server.getTool("web_search_exa").handler({ query: "AI breakthroughs" });

    const [, , request, , headers] = requestMock.mock.calls[0];
    expect(request.contents).toEqual({ highlights: { dynamic: true } });
    expect(headers).toEqual({
      "x-exa-integration": "web-search-mcp",
      "Exa-Beta": "dynamic-highlights-2026-08-28",
    });
  });

  it("returns a friendly message when Exa has no results", async () => {
    const { registerWebSearchTool } = await import("../../../src/tools/webSearch.js");
    const server = new FakeMcpServer();
    requestMock.mockResolvedValue(emptySearchResponse);

    registerWebSearchTool(server as any);

    await expect(
      server.getTool("web_search_exa").handler({
        query: "nothing",
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "No search results found. Please try a different query." }],
    });
  });

  it("rotates across KeyPool keys on 402 and 429 until a healthy key succeeds", async () => {
    const { registerWebSearchTool } = await import("../../../src/tools/webSearch.js");
    const server = new FakeMcpServer();
    const keyPool = new KeyPool({
      inlineKeys: ["key-exhausted", "key-ratelimited", "key-healthy"],
      onWarn: () => {},
    });

    requestMock
      .mockRejectedValueOnce(new ExaError("No more credits", 402))
      .mockRejectedValueOnce(new ExaError("Rate limit exceeded", 429))
      .mockResolvedValueOnce(searchResponse);

    registerWebSearchTool(server as any, {
      keyPool,
      userProvidedApiKey: true,
    });

    const result = await server.getTool("web_search_exa").handler({
      query: "AI breakthroughs",
    });

    expect(exaConstructorMock).toHaveBeenNthCalledWith(1, "key-exhausted");
    expect(exaConstructorMock).toHaveBeenNthCalledWith(2, "key-ratelimited");
    expect(exaConstructorMock).toHaveBeenNthCalledWith(3, "key-healthy");
    expect((result as any).isError).toBeUndefined();
    expect((result as any).content[0].text).toContain("Title: Result One");
    expect(keyPool.acquire()?.key).toBe("key-healthy");
  });

  it("does not rotate or disable pool keys when Exa rejects query content with 403", async () => {
    const { registerWebSearchTool } = await import("../../../src/tools/webSearch.js");
    const server = new FakeMcpServer();
    const keyPool = new KeyPool({
      inlineKeys: ["key-1", "key-2"],
      onWarn: () => {},
    });

    requestMock.mockRejectedValueOnce(new ExaError("Content was rejected by a safety policy", 403));

    registerWebSearchTool(server as any, {
      keyPool,
      userProvidedApiKey: true,
    });

    const result = await server.getTool("web_search_exa").handler({
      query: "blocked topic",
    });

    expect(exaConstructorMock).toHaveBeenCalledTimes(1);
    expect((result as any).isError).toBe(true);
    expect((result as any).content[0].text).toContain("403");
    expect(keyPool.acquire()?.key).toBe("key-1");
  });
});
