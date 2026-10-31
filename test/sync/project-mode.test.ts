import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { decodeAppConfig } from "../../src/config.ts";

test("defaults ZED_HERDR_PROJECT_MODE to directory", async () => {
    const config = await Effect.runPromise(decodeAppConfig({}));

    expect(config.projectMode).toBe("directory");
    expect(config.zedBin).toBeUndefined();
});

test("accepts an explicit directory project mode", async () => {
    const config = await Effect.runPromise(
        decodeAppConfig({ ZED_HERDR_PROJECT_MODE: " directory " }),
    );

    expect(config.projectMode).toBe("directory");
});

test("accepts an explicit git-root project mode", async () => {
    const config = await Effect.runPromise(
        decodeAppConfig({ ZED_HERDR_PROJECT_MODE: " git-root " }),
    );

    expect(config.projectMode).toBe("git-root");
});

test("rejects invalid project modes with a bounded configuration error", async () => {
    for (const value of ["nested-git", "", "git_root"]) {
        const error = await Effect.runPromise(
            Effect.flip(decodeAppConfig({ ZED_HERDR_PROJECT_MODE: value })),
        );

        expect(error._tag).toBe("ConfigurationError");
        expect(error.key).toBe("ZED_HERDR_PROJECT_MODE");
        expect(error.message.length).toBeGreaterThan(0);
        expect(error.message.length).toBeLessThanOrEqual(4_096);
    }
});
