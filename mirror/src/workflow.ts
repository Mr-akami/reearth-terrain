// Workflow that mirrors one Protomaps daily PMTiles archive into the
// shared R2 bucket. The upstream archives at build.protomaps.com expire
// after roughly a week, so the main worker normally walks back daily
// dates until it finds one — by snapshotting a build into R2 once a
// month we get a stable, long-lived copy and stop depending on the
// upstream's retention.
//
// Each `step.do` is its own Worker invocation as far as the runtime is
// concerned: the value it returns is persisted by the Workflows engine,
// and a failure inside one step retries that step without re-running
// the others. That's what makes it safe to copy ~100 GB across
// thousands of multipart parts: any single part can fail and resume.
//
// Robustness, learned the hard way (a monthly run once reported
// "Completed" while production kept serving a five-week-old snapshot):
//   - `init` short-circuits when the pointer already records this exact
//     date+size and the body is present — so a re-fire or an accidental
//     duplicate run is a cheap no-op instead of a second full upload
//     racing the first on the same key.
//   - `verify-object` HEADs the freshly-completed object before the
//     pointer is advanced, so we never point at a phantom / short body.
//   - `retain` never deletes the version we just mirrored.
//   - `verify-pointer` re-reads `latest.json` and HEADs its target as
//     the final step: if production isn't actually serving this run's
//     version, the Workflow FAILS loudly instead of completing silently.

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export interface PmtilesMirrorParams {
  /** Override the resolved upstream date. Empty / undefined = auto-probe. */
  date?: string;
}

interface FreshInit {
  kind: "fresh";
  date: string;
  url: string;
  size: number;
  partSize: number;
  partCount: number;
  uploadId: string;
  key: string;
}

interface SkipInit {
  kind: "skip";
  date: string;
  url: string;
  size: number;
  key: string;
}

type InitResult = FreshInit | SkipInit;

interface CompletedPart {
  partNumber: number;
  etag: string;
}

// Shape of the `latest.json` pointer the main worker reads at request time.
interface Pointer {
  date: string;
  key: string;
  size: number;
  upstream: string;
  mirroredAt: string;
}

const MAX_PROBE_DAYS = 14;

export class PmtilesMirrorWorkflow extends WorkflowEntrypoint<Env, PmtilesMirrorParams> {
  override async run(event: WorkflowEvent<PmtilesMirrorParams>, step: WorkflowStep): Promise<unknown> {
    const pointerKey = `${this.env.MIRROR_PREFIX}/latest.json`;

    const init = await step.do("init", async (): Promise<InitResult> => {
      const date = event.payload.date?.trim() || (await probeLatestDate(this.env.UPSTREAM_BASE));
      const url = `${this.env.UPSTREAM_BASE}/${date}.pmtiles`;
      const head = await fetch(url, { method: "HEAD" });
      if (!head.ok) throw new Error(`HEAD ${url} -> ${head.status}`);
      const len = head.headers.get("content-length");
      if (!len) throw new Error(`HEAD ${url} did not return content-length`);
      const size = Number.parseInt(len, 10);
      if (!Number.isFinite(size) || size <= 0) throw new Error(`bad content-length: ${len}`);

      const key = `${this.env.MIRROR_PREFIX}/${date}.pmtiles`;

      // Skip path: the pointer already records this exact date + size and
      // the mirrored body is present at the right size. Catches monthly
      // re-fires, manual re-runs, and accidental duplicate instances —
      // all of which would otherwise launch a second full upload to the
      // same key and race the first. We still re-write the pointer
      // downstream so `mirroredAt` advances.
      const existingPtr = await this.env.R2.get(pointerKey);
      if (existingPtr) {
        const parsed = (await existingPtr.json()) as Pointer;
        if (parsed.date === date && parsed.size === size && parsed.key === key) {
          const body = await this.env.R2.head(key);
          if (body && body.size === size) {
            return { kind: "skip", date, url, size, key };
          }
        }
      }

      const partSize = Number.parseInt(this.env.PART_SIZE, 10);
      if (!Number.isFinite(partSize) || partSize < 5 * 1024 * 1024) {
        throw new Error(`PART_SIZE must be >= 5 MiB, got ${this.env.PART_SIZE}`);
      }
      const partCount = Math.ceil(size / partSize);
      if (partCount > 10_000) {
        throw new Error(`would require ${partCount} parts; R2 multipart max is 10000`);
      }

      const mpu = await this.env.R2.createMultipartUpload(key, {
        httpMetadata: { contentType: "application/vnd.pmtiles" },
        customMetadata: {
          upstream: url,
          mirroredAt: new Date().toISOString(),
        },
      });

      return { kind: "fresh", date, url, size, partSize, partCount, uploadId: mpu.uploadId, key };
    });

    if (init.kind === "fresh") {
      // Each part is its own step so a transient upstream / R2 hiccup only
      // re-runs the failing chunk. Sequential rather than parallel: a 100 GB
      // archive at 50 MiB parts is ~2000 sequential subrequests, easily
      // within the Workflow's overall budget, and keeps peak memory bounded.
      const parts: CompletedPart[] = [];
      for (let i = 0; i < init.partCount; i++) {
        const partNumber = i + 1;
        const start = i * init.partSize;
        const endExclusive = Math.min(init.size, start + init.partSize);
        const part = await step.do(`part-${partNumber}`, async (): Promise<CompletedPart> => {
          const res = await fetch(init.url, {
            headers: { range: `bytes=${start}-${endExclusive - 1}` },
          });
          if (res.status !== 206 && res.status !== 200) {
            throw new Error(`range fetch ${init.url} [${start}-${endExclusive - 1}] -> ${res.status}`);
          }
          const body = await res.arrayBuffer();
          if (body.byteLength !== endExclusive - start) {
            throw new Error(
              `range fetch returned ${body.byteLength} bytes, expected ${endExclusive - start}`,
            );
          }
          const mpu = this.env.R2.resumeMultipartUpload(init.key, init.uploadId);
          const uploaded = await mpu.uploadPart(partNumber, body);
          return { partNumber, etag: uploaded.etag };
        });
        parts.push(part);
      }

      await step.do("complete", async () => {
        const mpu = this.env.R2.resumeMultipartUpload(init.key, init.uploadId);
        await mpu.complete(parts);
      });

      // `complete` returning is not proof the object is durably readable
      // — verify before we let the pointer advance to it. A missing or
      // short body fails the run here rather than producing a pointer to
      // a phantom archive.
      await step.do("verify-object", async () => {
        const obj = await this.env.R2.head(init.key);
        if (!obj) throw new Error(`verify-object: ${init.key} missing after complete`);
        if (obj.size !== init.size) {
          throw new Error(`verify-object: ${init.key} size ${obj.size} != expected ${init.size}`);
        }
      });

      // Pointer file the main worker reads at request time. Tiny enough
      // that a get-per-instance is cheap; we still memoize on the read side.
      await step.do("write-latest", async () => {
        await this.env.R2.put(pointerKey, pointerBody(init), {
          httpMetadata: { contentType: "application/json" },
        });
      });

      await step.do("retain", async () => {
        const retain = Number.parseInt(this.env.RETAIN_VERSIONS, 10);
        if (!Number.isFinite(retain) || retain < 1) return;
        const listed = await this.env.R2.list({ prefix: `${this.env.MIRROR_PREFIX}/` });
        const archives = listed.objects
          .filter((o) => o.key.endsWith(".pmtiles"))
          .sort((a, b) => (a.key < b.key ? 1 : -1));
        const toDelete = archives
          .slice(retain)
          .map((o) => o.key)
          // Never delete the version we just mirrored: it is the one the
          // pointer now serves, and retention must never remove the live
          // archive regardless of how the list happens to sort.
          .filter((k) => k !== init.key);
        if (toDelete.length > 0) await this.env.R2.delete(toDelete);
      });
    } else {
      // Skip path: refresh `mirroredAt` so the pointer reflects this run.
      await step.do("refresh-pointer", async () => {
        await this.env.R2.put(pointerKey, pointerBody(init), {
          httpMetadata: { contentType: "application/json" },
        });
      });
    }

    // Final gate: production must actually be serving the version this
    // run produced. Re-read the pointer and HEAD its target — if the
    // pointer drifted, points elsewhere, or its body is missing/short,
    // FAIL the Workflow so the breakage is visible instead of a silent
    // "Completed" over a stale snapshot.
    await step.do("verify-pointer", async () => {
      const ptrObj = await this.env.R2.get(pointerKey);
      if (!ptrObj) throw new Error("verify-pointer: latest.json missing after mirror");
      const ptr = (await ptrObj.json()) as Pointer;
      if (ptr.date !== init.date) {
        throw new Error(`verify-pointer: latest.json date ${ptr.date} != expected ${init.date}`);
      }
      if (ptr.key !== init.key) {
        throw new Error(`verify-pointer: latest.json key ${ptr.key} != expected ${init.key}`);
      }
      const body = await this.env.R2.head(ptr.key);
      if (!body) throw new Error(`verify-pointer: pointed body ${ptr.key} missing`);
      if (body.size !== init.size) {
        throw new Error(`verify-pointer: pointed body size ${body.size} != expected ${init.size}`);
      }
    });

    console.log(
      JSON.stringify({
        event: "mirror_complete",
        source: "protomaps",
        date: init.date,
        key: init.key,
        size: init.size,
        kind: init.kind,
      }),
    );

    return { ok: true, date: init.date, key: init.key, size: init.size, kind: init.kind };
  }
}

function pointerBody(init: InitResult): string {
  const ptr: Pointer = {
    date: init.date,
    key: init.key,
    size: init.size,
    upstream: init.url,
    mirroredAt: new Date().toISOString(),
  };
  return JSON.stringify(ptr);
}

async function probeLatestDate(base: string): Promise<string> {
  const now = Date.now();
  for (let i = 0; i < MAX_PROBE_DAYS; i++) {
    const date = formatUtcDate(new Date(now - i * 86_400_000));
    const r = await fetch(`${base}/${date}.pmtiles`, { method: "HEAD" });
    if (r.ok) return date;
  }
  throw new Error(`no Protomaps build found at ${base} within ${MAX_PROBE_DAYS} days`);
}

function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${d.getUTCDate()}`.padStart(2, "0");
  return `${y}${m}${day}`;
}
