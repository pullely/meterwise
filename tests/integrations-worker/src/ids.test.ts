import {
  connectionPublicId,
  parseConnectionPublicId,
  repoLinkPublicId,
  parseRepoLinkPublicId,
  inboundDeliveryPublicId,
  parseInboundDeliveryPublicId,
  parseOrgPublicId,
  parseProjectPublicId,
} from "@integrations-worker/ids";

const UUID = "11111111-2222-3333-4444-555555555555";
const HEX = "11111111222233334444555555555555";

describe("integrations-worker public ids", () => {
  it("encodes and parses connection ids (int_)", () => {
    expect(connectionPublicId(UUID)).toBe(`int_${HEX}`);
    expect(parseConnectionPublicId(`int_${HEX}`)).toBe(UUID);
  });

  it("encodes and parses repo link ids (repl_)", () => {
    expect(repoLinkPublicId(UUID)).toBe(`repl_${HEX}`);
    expect(parseRepoLinkPublicId(`repl_${HEX}`)).toBe(UUID);
  });

  it("encodes and parses inbound delivery ids (igd_)", () => {
    expect(inboundDeliveryPublicId(UUID)).toBe(`igd_${HEX}`);
    expect(parseInboundDeliveryPublicId(`igd_${HEX}`)).toBe(UUID);
  });

  it("rejects wrong prefixes and malformed hex", () => {
    expect(parseConnectionPublicId(`repl_${HEX}`)).toBeNull();
    expect(parseRepoLinkPublicId(`int_${HEX}`)).toBeNull();
    expect(parseInboundDeliveryPublicId("igd_nothex")).toBeNull();
    expect(parseConnectionPublicId("int_short")).toBeNull();
  });

  it("parses org and project public ids via the shared decoder", () => {
    expect(parseOrgPublicId(`org_${HEX}`)).toBe(UUID);
    expect(parseProjectPublicId(`prj_${HEX}`)).toBe(UUID);
    expect(parseOrgPublicId(`prj_${HEX}`)).toBeNull();
  });
});
