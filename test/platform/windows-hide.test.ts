import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWindows = process.platform === "win32";

interface ConsoleProbeResult {
    readonly parentConsole: string;
    readonly childConsole: string;
    readonly exitCode: number;
    readonly error?: string;
}

const runnerSource = `
const { dlopen, FFIType } = await import("bun:ffi");
const BunContext = await import("@effect/platform-bun/BunContext");
const Command = await import("@effect/platform/Command");
const CommandExecutor = await import("@effect/platform/CommandExecutor");
const Effect = await import("effect/Effect");
const Stream = await import("effect/Stream");

const resultPath = process.env.ZED_HERDR_TEST_RESULT;
const kernel32 = dlopen("kernel32.dll", {
    GetConsoleWindow: { args: [], returns: FFIType.ptr },
});
const parentConsole = String(kernel32.symbols.GetConsoleWindow());
const probe = 'const { dlopen, FFIType } = require("bun:ffi"); const kernel32 = dlopen("kernel32.dll", { GetConsoleWindow: { args: [], returns: FFIType.ptr } }); console.log(String(kernel32.symbols.GetConsoleWindow()));';
const program = Effect.scoped(
    Effect.gen(function* () {
        const executor = yield* CommandExecutor.CommandExecutor;
        const child = yield* executor.start(Command.make(process.execPath, "-e", probe));
        const chunks = yield* Stream.runCollect(child.stdout);
        const exitCode = yield* child.exitCode;
        return {
            childConsole: Buffer.concat(Array.from(chunks)).toString().trim(),
            exitCode: Number(exitCode),
        };
    }),
);
try {
    const result = await Effect.runPromise(program.pipe(Effect.provide(BunContext.layer)));
    await Bun.write(resultPath, JSON.stringify({ parentConsole, ...result }));
} catch (error) {
    await Bun.write(resultPath, JSON.stringify({ parentConsole, error: String(error) }));
}
`;

test.skipIf(!isWindows)(
    "Effect Command.start hides the child console window",
    async () => {
        const dir = await mkdtemp(join(tmpdir(), "zed-herdr-windows-hide-"));
        const resultPath = join(dir, "result.json");
        const parent = Bun.spawn({
            cmd: [process.execPath, "-e", runnerSource],
            cwd: join(import.meta.dir, "..", ".."),
            env: { ...process.env, ZED_HERDR_TEST_RESULT: resultPath },
            detached: true,
            windowsHide: true,
            stdio: ["ignore", "ignore", "ignore"],
        });
        parent.unref();
        try {
            let result: ConsoleProbeResult | undefined;
            for (let attempt = 0; attempt < 100 && result === undefined; attempt += 1) {
                await Bun.sleep(100);
                const text = await readFile(resultPath, "utf8").catch(() => "");
                try {
                    result = JSON.parse(text) as ConsoleProbeResult;
                } catch {
                    result = undefined;
                }
            }
            expect(result).toBeDefined();
            if (result === undefined) {
                throw new Error("console probe produced no result");
            }
            expect(result.error).toBeUndefined();
            expect(["0", "null"]).toContain(result.parentConsole);
            expect(["0", "null"]).toContain(result.childConsole);
            expect(result.exitCode).toBe(0);
        } finally {
            if (parent.exitCode === null) {
                parent.kill();
            }
            await parent.exited;
            await rm(dir, { recursive: true, force: true });
        }
    },
    15_000,
);
