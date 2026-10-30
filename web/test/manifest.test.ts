import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// vitest runs from the web/ folder (jsdom replaces the global URL, so paths are built from cwd)
const pub = (name: string) => join(process.cwd(), "public", name);
const manifest = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8")) as {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  lang: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
};

/** width and height written in a PNG's header */
function pngSize(file: string): [number, number] {
  const buf = readFileSync(file);
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe("PWA manifest", () => {
  it("declares an installable standalone Thai app that starts at /", () => {
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.lang).toBe("th");
    expect(manifest.name).toMatch(/[฀-๿]/);
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });

  it("has a 192, a 512 and a maskable icon, and every icon file exists at its stated size", () => {
    const purposes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
    expect(purposes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
    for (const icon of manifest.icons) {
      const file = pub(icon.src.replace(/^\//, ""));
      expect(existsSync(file), icon.src).toBe(true);
      const [w, h] = pngSize(file);
      expect(`${w}x${h}`).toBe(icon.sizes);
    }
  });

  it("has the iOS home-screen icon the layout links to", () => {
    expect(pngSize(pub("apple-touch-icon.png"))).toEqual([180, 180]);
  });

  it("has an offline page in Thai", () => {
    const html = readFileSync(pub("offline.html"), "utf8");
    expect(html).toContain('lang="th"');
    expect(html).toMatch(/ไม่มีสัญญาณ/);
  });
});
