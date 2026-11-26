import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { REPORT_TEMPLATE_GZIP_BASE64 } from "../src/render/report-template.generated.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("embedded report artifact", () => {
  it("matches the committed Vite single-file build", () => {
    const html = gunzipSync(Buffer.from(REPORT_TEMPLATE_GZIP_BASE64, "base64")).toString("utf8");
    const committed = fs.readFileSync(path.join(root, "web", "dist", "report.html"), "utf8");
    expect(html).toBe(committed);
    expect(html).toContain('id="tsray-data"');
    expect(html).toContain("__TSRAY_REPORT_DATA__");
  });

  it("embeds complete license notices for standalone distribution", () => {
    const html = gunzipSync(Buffer.from(REPORT_TEMPLATE_GZIP_BASE64, "base64")).toString("utf8");
    const match = /<script id="tsray-licenses" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const notices = JSON.parse(match![1]!) as Record<
      string,
      { license: string; text: string; sourceCode?: string; sourceArchive?: string }
    >;
    const names = Object.keys(notices);
    expect(names.some((name) => name.startsWith("tsray "))).toBe(true);
    expect(names.some((name) => name.startsWith("React "))).toBe(true);
    expect(names.some((name) => name.startsWith("Tailwind CSS "))).toBe(true);
    const elk = Object.entries(notices).find(([name]) => name.startsWith("elkjs "))?.[1];
    expect(elk?.license).toBe("EPL-2.0");
    expect(elk?.text).toContain("THE ACCOMPANYING PROGRAM IS PROVIDED UNDER THE TERMS");
    expect(elk?.text).toContain("Exhibit A");
    expect(elk?.sourceCode).toContain("https://github.com/kieler/elkjs/tree/");
    expect(elk?.sourceArchive).toContain("https://github.com/kieler/elkjs/archive/");
    for (const notice of Object.values(notices)) {
      if (notice.license === "MIT") {
        expect(notice.text).toContain("Permission is hereby granted, free of charge");
        expect(notice.text).toContain("THE SOFTWARE IS PROVIDED \"AS IS\"");
      }
    }
  });
});
