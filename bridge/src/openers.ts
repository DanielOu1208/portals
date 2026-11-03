import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostOS, type HostOS } from "./platform.ts";

// The apps on this computer a thread's folder can be opened in, for the panel beside the
// chat (feature open_on_host, `host.apps`, `folder.open`; 2026-10-31: the Finder,
// the editors and the terminals found installed, opened on this computer's own screen,
// whichever device asks. Only a thread's folder is opened, never a path a device names.
// On Linux, the desktop's file manager only (`xdg-open`).
//
// Each app comes with its icon, for the panel's Open in menu (2026-11-01: "with
// the actual app icons"): the one the app ships, as it looks in macOS's default style,
// whatever style this Mac shows icons in, else the system's for it; drawn by AppKit
// through osascript's JavaScript, which every Mac has. Drawn once an app, kept while its
// bundle is unchanged.

export interface HostApp {
  /** Ours, for `folder.open`. */
  id: string;
  /** As the app is called. */
  name: string;
  kind: "files" | "editor" | "terminal";
  /** Its icon, a PNG of `iconSide` pixels a side, in base64; absent where none could be drawn. */
  icon?: string;
}

/** An icon's side in pixels: sharp at about 20 points on a 3x screen. */
export const iconSide = 64;

interface Known extends HostApp {
  /** The app's bundle, in one of the folders apps are kept in. */
  bundle: string;
}

/** In the order the panel lists them: the Finder, the editors, the terminals. */
const known: Known[] = [
  { id: "finder", name: "Finder", kind: "files", bundle: "Finder.app" },
  { id: "vscode", name: "VS Code", kind: "editor", bundle: "Visual Studio Code.app" },
  { id: "cursor", name: "Cursor", kind: "editor", bundle: "Cursor.app" },
  { id: "zed", name: "Zed", kind: "editor", bundle: "Zed.app" },
  { id: "windsurf", name: "Windsurf", kind: "editor", bundle: "Windsurf.app" },
  { id: "sublime", name: "Sublime Text", kind: "editor", bundle: "Sublime Text.app" },
  { id: "xcode", name: "Xcode", kind: "editor", bundle: "Xcode.app" },
  { id: "terminal", name: "Terminal", kind: "terminal", bundle: "Terminal.app" },
  { id: "ghostty", name: "Ghostty", kind: "terminal", bundle: "Ghostty.app" },
  { id: "iterm", name: "iTerm", kind: "terminal", bundle: "iTerm.app" },
  { id: "warp", name: "Warp", kind: "terminal", bundle: "Warp.app" },
];

function appFolders(): string[] {
  return [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    "/System/Library/CoreServices",
    join(homedir(), "Applications"),
  ];
}

export class OpenError extends Error {}

export class Openers {
  private readonly os: HostOS;
  private readonly folders: string[];
  private readonly exists: (path: string) => boolean;
  private readonly icons: AppIcons;

  private readonly launch: (command: string, args: string[]) => Promise<void>;
  private readonly isPackage: (path: string) => Promise<boolean>;

  constructor(os: HostOS = hostOS, folders = appFolders(), exists: (path: string) => boolean = existsSync, icons: AppIcons = new AppIcons(), launcher: (command: string, args: string[]) => Promise<void> = launch, isPackage: (path: string) => Promise<boolean> = isFilePackage) {
    this.os = os;
    this.folders = folders;
    this.exists = exists;
    this.icons = icons;
    this.launch = launcher;
    this.isPackage = isPackage;
  }

  /** The apps installed now (looked for at each ask: one installed meanwhile shows), with their icons. */
  async apps(): Promise<HostApp[]> {
    if (this.os === "linux") return this.exists("/usr/bin/xdg-open") ? [{ id: "files", name: "Files", kind: "files" }] : [];
    const found = known.flatMap((app) => {
      const bundle = this.bundle(app);
      return bundle ? [{ app, bundle }] : [];
    });
    const icons = await this.icons.of(found.map(({ bundle }) => bundle));
    return found.map(({ app: { id, name, kind }, bundle }) => ({ id, name, kind, ...(icons.get(bundle) ? { icon: icons.get(bundle) } : {}) }));
  }

  /** Opens `folder` in the app `id`; rejects with why it could not. */
  async open(id: string, thread: string): Promise<void> {
    // What it is now: a thread's folder replaced by a link to a bundle is a bundle, though
    // the system takes the link for no package.
    const folder = await realpath(thread).catch(() => null);
    if (!folder || !isFolder(folder)) throw new OpenError("This thread's folder is not there any more.");
    if (this.os === "linux") {
      if (id !== "files") throw new OpenError("That app is not on this computer.");
      return this.launch("/usr/bin/xdg-open", [folder]);
    }
    const app = known.find((candidate) => candidate.id === id);
    const bundle = app ? this.bundle(app) : null;
    if (!bundle) throw new OpenError("That app is not on this computer.");
    // Always named, the Finder too. A folder that is a bundle the Finder would run as its
    // app, even named (tried on macOS 27, 2026-11-02), so that one is only shown in the Finder.
    if (app!.id === "finder" && (await this.isPackage(folder))) return this.launch("/usr/bin/open", ["-R", folder]);
    return this.launch("/usr/bin/open", ["-a", bundle, folder]);
  }

  private bundle(app: Known): string | null {
    for (const folder of this.folders) {
      const path = join(folder, app.bundle);
      if (this.exists(path)) return path;
    }
    return null;
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The system takes `path` for a package, one thing and not a folder (`Foo.app`, `Foo.xcodeproj`); yes when it cannot say. */
function isFilePackage(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", packageScript, path], { timeout: 10_000 }, (error, stdout) => resolve(error ? true : String(stdout).trim() !== "false"));
  });
}

const packageScript = `
ObjC.import('AppKit');
function run(argv) {
  return String($.NSWorkspace.sharedWorkspace.isFilePackageAtPath(argv[0]));
}
`;

function launch(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      // `open` run with no screen to open on (a host started over ssh): its own words.
      const said = String(stderr).trim().split("\n").at(-1);
      reject(new OpenError(said ? `It could not be opened: ${said}` : "It could not be opened on this computer."));
    });
  });
}

/**
 * Draws apps' icons as PNGs, all of those not drawn yet in one run of osascript, and keeps
 * each while its bundle is unchanged. None at all where osascript fails or is not there.
 */
export class AppIcons {
  private readonly kept = new Map<string, { changed: number; icon: string }>();
  private readonly draw: (bundles: string[]) => Promise<Record<string, string>>;

  constructor(draw: (bundles: string[]) => Promise<Record<string, string>> = drawIcons) {
    this.draw = draw;
  }

  async of(bundles: string[]): Promise<Map<string, string>> {
    const changed = new Map(bundles.map((bundle) => [bundle, modified(bundle)]));
    const missing = bundles.filter((bundle) => this.kept.get(bundle)?.changed !== changed.get(bundle));
    if (missing.length > 0) {
      const drawn = await this.draw(missing).catch(() => ({}) as Record<string, string>);
      for (const bundle of missing) {
        const icon = drawn[bundle];
        if (typeof icon === "string" && icon !== "") this.kept.set(bundle, { changed: changed.get(bundle)!, icon });
      }
    }
    return new Map(bundles.flatMap((bundle) => (this.kept.get(bundle) ? [[bundle, this.kept.get(bundle)!.icon] as const] : [])));
  }
}

function modified(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** The bundles' icons, by bundle, as base64 PNGs `iconSide` pixels a side. */
function drawIcons(bundles: string[]): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", iconScript, String(iconSide), ...bundles], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(JSON.parse(String(stdout)) as Record<string, string>);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

/** For osascript: the icon each app ships (its `CFBundleIconFile`), else the system's for it, drawn into a bitmap of the side asked. */
const iconScript = `
ObjC.import('AppKit');
function run(argv) {
  const side = Number(argv[0]);
  const icons = {};
  for (const app of argv.slice(1)) {
    try {
      let icon = null;
      const bundle = $.NSBundle.bundleWithPath(app);
      const named = bundle.isNil() ? null : bundle.objectForInfoDictionaryKey('CFBundleIconFile');
      if (named && !named.isNil()) {
        let file = ObjC.unwrap(named);
        if (!file.endsWith('.icns')) file += '.icns';
        const loaded = $.NSImage.alloc.initWithContentsOfFile(bundle.resourcePath.js + '/' + file);
        if (!loaded.isNil()) icon = loaded;
      }
      if (!icon) icon = $.NSWorkspace.sharedWorkspace.iconForFile(app);
      const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, side, side, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
      const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
      $.NSGraphicsContext.saveGraphicsState;
      $.NSGraphicsContext.setCurrentContext(context);
      icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, side, side), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1.0);
      context.flushGraphics;
      $.NSGraphicsContext.restoreGraphicsState;
      icons[app] = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).base64EncodedStringWithOptions(0).js;
    } catch (error) {}
  }
  return JSON.stringify(icons);
}
`;
