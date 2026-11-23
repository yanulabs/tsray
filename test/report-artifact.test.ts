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
});
