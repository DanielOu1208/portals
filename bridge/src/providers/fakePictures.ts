import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

// The fake agent's turn that shows images (a message with "imagetest" in it), for trying
// the app's images in replies and its file viewer without a real agent (feature
// file_read): it makes a chart in the thread's folder and one in the temporary folder,
// names a file the bridge will not give as an image (it is not one), edits a file in the
// thread's folder and reads it, then shows the images in its reply.

/** A PNG of `width` by `height` pixels, each as `pixel` colours it (red, green, blue). */
export function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      rows[row + 1 + x * 3] = r;
      rows[row + 2 + x * 3] = g;
      rows[row + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** A bar chart of `values` (0 to 1) on white: what an agent's matplotlib might make. */
export function barChart(values: number[], width = 640, height = 400): Buffer {
  const margin = 40;
  const slot = (width - margin * 2) / values.length;
  return png(width, height, (x, y) => {
    if (y === height - margin || (x === margin && y < height - margin && y > margin / 2)) return [60, 60, 67];
    const index = Math.floor((x - margin) / slot);
    const within = (x - margin) % slot;
    if (index >= 0 && index < values.length && within > slot * 0.18 && within < slot * 0.82) {
      const top = height - margin - values[index] * (height - margin * 2);
      if (y > top && y < height - margin) return index % 2 === 0 ? [10, 132, 255] : [94, 92, 230];
    }
    return [255, 255, 255];
  });
}

/** A tall gradient, for an image taller than a screen. */
export function tallGradient(width = 360, height = 1400): Buffer {
  return png(width, height, (x, y) => [Math.round((y / height) * 255), 120, Math.round((x / width) * 255)]);
}

export interface PictureFiles {
  /** In the thread's folder. */
  chart: string;
  /** In the temporary folder, outside the thread's. */
  plot: string;
  /** A file the bridge does not give as an image: text. */
  notImage: string;
  /** A text file in the thread's folder, edited. */
  notes: string;
}

/** Makes the files the turn shows. */
export async function makePictures(cwd: string, thread: string): Promise<PictureFiles> {
  const folder = join(cwd, "fake-pictures");
  await mkdir(folder, { recursive: true });
  const chart = join(folder, "sales-chart.png");
  await writeFile(chart, barChart([0.35, 0.5, 0.42, 0.78, 0.66, 0.9]));
  const plot = join(tmpdir(), `portals-fake-plot-${thread.slice(0, 8)}.png`);
  await writeFile(plot, tallGradient());
  const notes = join(folder, "notes.md");
  const lines = Array.from({ length: 60 }, (_, index) => `Line ${index + 1}: ${index === 41 ? "the edited line, now with more words" : "a line of the notes"}`);
  await writeFile(notes, `# Notes\n\n${lines.join("\n")}\n`);
  return { chart, plot, notImage: "/etc/hosts", notes };
}

/** The reply: the images, a link to the notes, and words around them. */
export function picturesReply(files: PictureFiles): string {
  return [
    "A tall one from the temporary folder:",
    "",
    `![A tall gradient](${files.plot})`,
    "",
    "This one is not an image, so the app should say it cannot show it:",
    "",
    `![Not an image](${files.notImage})`,
    "",
    `A remote image is only a link: ![a remote logo](https://example.com/logo.png). The notes I edited: [notes.md](${files.notes}:44).`,
    "",
    "And the chart I made, in the project:",
    "",
    "![Sales by month](fake-pictures/sales-chart.png)",
  ].join("\n");
}
