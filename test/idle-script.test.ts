import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOnstart } from "../src/guard.js";

// Runs the idle watcher the onstart script writes, with fake `sleep` and `nvidia-smi`
// on PATH. `readings` is what nvidia-smi prints each minute (one line per GPU).
// Returns the minute at which it destroyed the box, or undefined if it never did.
function runIdleWatcher(idleMinutes: number, readings: string[]): number | undefined {
  const onstart = buildOnstart({ expiresAt: 1, destroyOnExit: false, apiUrl: "u", idleMinutes });
  const script = /cat > \/tmp\/vast-mcp-idle\.sh <<'VASTMCPIDLE'\n([\s\S]*?)\nVASTMCPIDLE/.exec(onstart)![1];
  const dir = mkdtempSync(join(tmpdir(), "vast-mcp-idle-"));
  const bin = join(dir, "bin");
  execFileSync("mkdir", [bin]);
  writeFileSync(join(dir, "readings"), readings.join("\n---\n"));
  const exe = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // Each fake minute bumps a counter; the run stops when readings run out.
  exe("sleep", `n=$(cat ${dir}/minute 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${dir}/minute; [ $n -gt ${readings.length} ] && kill $PPID; exit 0`);
  exe("nvidia-smi", `n=$(cat ${dir}/minute); awk -v RS='\\n---\\n' -v n="$n" 'NR==n' ${dir}/readings`);
  exe("destroy", `cat ${dir}/minute > ${dir}/destroyed`);
  const patched = script.replaceAll("/tmp/vast-mcp-destroy.sh", join(bin, "destroy")).replaceAll("/proc/1/fd/1", "/dev/null");
  writeFileSync(join(dir, "idle.sh"), patched);
  try {
    execFileSync("sh", [join(dir, "idle.sh")], { env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: "ignore" });
  } catch {
    // killed by the fake sleep when readings ran out
  }
  return existsSync(join(dir, "destroyed")) ? Number(readFileSync(join(dir, "destroyed"), "utf8")) : undefined;
}

describe("idle auto-destroy script", () => {
  it("destroys after N idle minutes in a row", () => {
    expect(runIdleWatcher(3, ["90", "90", "1", "0", "2", "0", "0"])).toBe(5);
  });

  it("resets the count when the GPU gets busy again", () => {
    expect(runIdleWatcher(3, ["0", "0", "50", "0", "0", "40", "0", "0"])).toBeUndefined();
  });

  it("keeps a multi-GPU box alive while any GPU works", () => {
    expect(runIdleWatcher(2, ["0\n85", "0\n85", "0\n85", "0\n85"])).toBeUndefined();
    expect(runIdleWatcher(2, ["0\n85", "0\n0", "1\n2"])).toBe(3);
  });

  it("is off when idle minutes is 0", () => {
    expect(buildOnstart({ expiresAt: 1, destroyOnExit: false, apiUrl: "u", idleMinutes: 0 })).not.toContain("vast-mcp-idle");
  });
});
