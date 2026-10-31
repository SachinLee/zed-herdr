import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ConfigurationError } from "./domain/errors.ts";
import type { ProjectMode } from "./domain/workspace.ts";

const Environment = Schema.Struct({
    ZED_BIN: Schema.optional(Schema.String),
});

export interface AppConfig {
    readonly zedBin: string | undefined;
    readonly projectMode: ProjectMode;
}

const isProjectMode = (value: string): value is ProjectMode =>
    value === "git-root" || value === "directory";

export const decodeAppConfig = (
    environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<AppConfig, ConfigurationError> => {
    const decoded = Schema.decodeUnknownEither(Environment)(environment);
    if (Either.isLeft(decoded)) {
        return Effect.fail(
            new ConfigurationError({
                key: "ZED_BIN",
                message: String(decoded.left),
            }),
        );
    }

    const zedBin = decoded.right.ZED_BIN?.trim();
    if (decoded.right.ZED_BIN !== undefined && zedBin?.length === 0) {
        return Effect.fail(
            new ConfigurationError({
                key: "ZED_BIN",
                message: "ZED_BIN must be a non-empty executable path",
            }),
        );
    }

    const rawProjectMode = environment.ZED_HERDR_PROJECT_MODE;
    const projectMode = rawProjectMode === undefined ? "directory" : rawProjectMode.trim();
    if (!isProjectMode(projectMode)) {
        return Effect.fail(
            new ConfigurationError({
                key: "ZED_HERDR_PROJECT_MODE",
                message: 'ZED_HERDR_PROJECT_MODE must be "git-root" or "directory"',
            }),
        );
    }

    return Effect.succeed({ zedBin, projectMode });
};
