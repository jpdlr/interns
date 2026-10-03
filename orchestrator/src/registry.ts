/**
 * Intern manifests on disk: ~/.interns/<slug>/intern.yaml (+ memory/ dir).
 * The registry owns the filesystem layout; the db mirrors identity rows for
 * queries. Archiving = moving the whole intern dir to ~/.interns/_fired/<slug>.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { internsHome } from "./config.js";
import { InternManifest, InternManifestSchema, slugify } from "./types.js";

const RESERVED = new Set(["_fired", "memory", "coordinator"]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED.has(slug);
}

export class Registry {
  constructor(private baseDir: string = internsHome()) {
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  internDir(slug: string): string {
    return path.join(this.baseDir, slug);
  }

  memoryDir(slug: string): string {
    return path.join(this.internDir(slug), "memory");
  }

  private manifestPath(slug: string): string {
    return path.join(this.internDir(slug), "intern.yaml");
  }

  /** Create or update an intern on disk. Returns the slug. */
  save(manifest: InternManifest, slug: string = slugify(manifest.name)): string {
    if (RESERVED.has(slug)) throw new Error(`slug "${slug}" is reserved`);
    const parsed = InternManifestSchema.parse(manifest);
    fs.mkdirSync(this.memoryDir(slug), { recursive: true });
    fs.writeFileSync(this.manifestPath(slug), YAML.stringify(parsed), "utf8");
    return slug;
  }

  /** Whether ~/.interns/<slug> exists, manifest or not. */
  has(slug: string): boolean {
    return fs.existsSync(this.internDir(slug));
  }

  get(slug: string): InternManifest | undefined {
    const file = this.manifestPath(slug);
    if (!fs.existsSync(file)) return undefined;
    return InternManifestSchema.parse(YAML.parse(fs.readFileSync(file, "utf8")));
  }

  list(): { slug: string; manifest: InternManifest }[] {
    if (!fs.existsSync(this.baseDir)) return [];
    return fs
      .readdirSync(this.baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !RESERVED.has(e.name) && !e.name.startsWith("_"))
      .flatMap((e) => {
        const manifest = this.get(e.name);
        return manifest ? [{ slug: e.name, manifest }] : [];
      });
  }

  /** Fire an intern: move its dir (manifest + memory) to _fired/. */
  archive(slug: string): void {
    const src = this.internDir(slug);
    if (!fs.existsSync(src)) throw new Error(`no such intern: ${slug}`);
    const firedDir = path.join(this.baseDir, "_fired");
    fs.mkdirSync(firedDir, { recursive: true });
    let dest = path.join(firedDir, slug);
    if (fs.existsSync(dest)) dest = `${dest}-${Date.now()}`;
    fs.renameSync(src, dest);
  }
}
