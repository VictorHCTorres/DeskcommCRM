import { describe, expect, it } from "vitest";

import { clickupLiveParentResultSchema } from "./contrato";

const base = {
  comments: [],
  assets: [],
  blob_receipts: [],
  comments_terminal: true,
  assets_terminal: true,
  replies_found: 0,
  bytes_downloaded: 0,
  warnings: [],
};

describe("fragmento live sidecar", () => {
  it("aceita checkpoint vazio e recusa URL/token persistidos", () => {
    expect(clickupLiveParentResultSchema.parse(base)).toEqual(base);
    expect(() =>
      clickupLiveParentResultSchema.parse({
        ...base,
        warnings: [{ code: "https://clickup.com/file?token=secret" }],
      }),
    ).toThrow(/URL ou segredo/);
  });
});
