import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIp, clientIp, exactClientIp, normalizeIp } from "@/lib/docs/clientIp";

afterEach(() => {
  vi.unstubAllEnvs();
});

const NF = "x-nf-client-connection-ip";
const XFF = "x-forwarded-for";
const h = (o: Record<string, string>) => new Headers(o);

describe("normalizeIp: the key form of an address", () => {
  const rows: [string, string, string][] = [
    // [description, input, key]
    ["IPv4 stays as it is", "203.0.113.7", "203.0.113.7"],
    ["IPv4 with a port loses the port", "203.0.113.7:51234", "203.0.113.7"],
    ["whitespace is trimmed", "  203.0.113.7 ", "203.0.113.7"],
    ["IPv6 becomes its /64", "2001:db8:abcd:12:1:2:3:4", "2001:db8:abcd:12::/64"],
    [
      "the interface half is dropped, so another address in the same /64 gives the same key",
      "2001:db8:abcd:12:ffff:ffff:ffff:ffff",
      "2001:db8:abcd:12::/64",
    ],
    ["compressed IPv6 expands before cutting", "2001:db8::1", "2001:db8:0:0::/64"],
    ["a compressed run in the middle", "2001:db8:1::5:6", "2001:db8:1:0::/64"],
    ["a compressed run that crosses the /64 line", "2001:db8:1:2::9", "2001:db8:1:2::/64"],
    ["upper case is lower-cased", "2001:DB8:ABCD:12::1", "2001:db8:abcd:12::/64"],
    ["leading zeros are dropped", "2001:0db8:0000:0012:0000:0000:0000:0001", "2001:db8:0:12::/64"],
    ["brackets and a port come off", "[2001:db8:abcd:12::1]:443", "2001:db8:abcd:12::/64"],
    ["a zone id comes off", "fe80::1%en0", "fe80:0:0:0::/64"],
    ["loopback", "::1", "0:0:0:0::/64"],
    ["IPv4-mapped (dotted) is the IPv4 address", "::ffff:203.0.113.7", "203.0.113.7"],
    ["IPv4-mapped (hex) is the IPv4 address", "::ffff:cb00:7107", "203.0.113.7"],
    ["IPv4-mapped in full form", "0:0:0:0:0:ffff:203.0.113.7", "203.0.113.7"],
    ["not an address", "not-an-ip", ""],
    ["empty", "", ""],
    ["too many groups", "1:2:3:4:5:6:7:8:9", ""],
    ["two double colons", "1::2::3", ""],
    ["an out of range IPv4", "999.1.1.1", ""],
    ["a script in the header", "<script>alert(1)</script>", ""],
  ];
  it.each(rows)("%s", (_d, input, key) => {
    expect(normalizeIp(input)).toBe(key);
  });

  it("every address in one /64 maps to one key, and a different /64 to a different one", () => {
    const keys = new Set(
      Array.from({ length: 200 }, (_, i) => normalizeIp(`2001:db8:1:2:${i.toString(16)}::${i}`)),
    );
    expect([...keys]).toEqual(["2001:db8:1:2::/64"]);
    expect(normalizeIp("2001:db8:1:3::1")).not.toBe(normalizeIp("2001:db8:1:2::1"));
  });
});

describe("canonicalIp: the full address for the record", () => {
  const rows: [string, string][] = [
    ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
    ["2001:DB8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["::1", "::1"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["[2001:db8::1]:8080", "2001:db8::1"],
    ["203.0.113.7", "203.0.113.7"],
    ["nonsense", ""],
  ];
  it.each(rows)("%s", (input, out) => {
    expect(canonicalIp(input)).toBe(out);
  });
});

describe("clientIp / exactClientIp: which header is trusted", () => {
  it("the platform header wins over anything the client wrote", () => {
    const headers = h({ [NF]: "9.9.9.9", [XFF]: "1.2.3.4, 5.6.7.8" });
    expect(clientIp(headers)).toBe("9.9.9.9");
    expect(exactClientIp(headers)).toBe("9.9.9.9");
  });

  it("an IPv6 platform address keys on its /64 but is kept whole for the record", () => {
    const headers = h({ [NF]: "2001:db8:abcd:12:aaaa:bbbb:cccc:dddd" });
    expect(clientIp(headers)).toBe("2001:db8:abcd:12::/64");
    expect(exactClientIp(headers)).toBe("2001:db8:abcd:12:aaaa:bbbb:cccc:dddd");
  });

  describe("in production", () => {
    it("with no platform header x-forwarded-for is not trusted at all: the answer is empty", () => {
      vi.stubEnv("NODE_ENV", "production");
      expect(clientIp(h({ [XFF]: "6.6.6.6, 7.7.7.7" }))).toBe("");
      expect(exactClientIp(h({ [XFF]: "6.6.6.6" }))).toBe("");
      expect(clientIp(h({}))).toBe("");
    });

    it("a client cannot pick its own bucket by writing x-forwarded-for", () => {
      vi.stubEnv("NODE_ENV", "production");
      const keys = new Set(
        Array.from({ length: 50 }, (_, i) => clientIp(h({ [XFF]: `10.0.0.${i}` }))),
      );
      expect([...keys]).toEqual([""]);
    });

    it("the platform header still works, and an unreadable one reads as no address", () => {
      vi.stubEnv("NODE_ENV", "production");
      expect(clientIp(h({ [NF]: "203.0.113.7", [XFF]: "6.6.6.6" }))).toBe("203.0.113.7");
      expect(clientIp(h({ [NF]: "garbage" }))).toBe("");
    });

    it("an IPv4-mapped platform address is the IPv4 address", () => {
      vi.stubEnv("NODE_ENV", "production");
      expect(clientIp(h({ [NF]: "::ffff:203.0.113.7" }))).toBe("203.0.113.7");
    });
  });

  describe("in development and tests", () => {
    it("falls back to the last x-forwarded-for entry (the one the nearest proxy appended)", () => {
      vi.stubEnv("NODE_ENV", "test");
      expect(clientIp(h({ [XFF]: "6.6.6.6, 7.7.7.7" }))).toBe("7.7.7.7");
      vi.stubEnv("NODE_ENV", "development");
      expect(clientIp(h({ [XFF]: "6.6.6.6, 7.7.7.7" }))).toBe("7.7.7.7");
    });

    it("an IPv6 forwarded entry is cut to its /64 too", () => {
      vi.stubEnv("NODE_ENV", "test");
      expect(clientIp(h({ [XFF]: "1.1.1.1, 2001:db8:1:2:3:4:5:6" }))).toBe("2001:db8:1:2::/64");
    });

    it("no headers: empty", () => {
      expect(clientIp(h({}))).toBe("");
    });

    it("a forwarded entry that is not an address reads as none", () => {
      vi.stubEnv("NODE_ENV", "test");
      expect(clientIp(h({ [XFF]: "1.1.1.1, evil" }))).toBe("");
    });
  });
});
