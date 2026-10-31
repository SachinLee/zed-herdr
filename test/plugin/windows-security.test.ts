import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Schema from "effect/Schema";

import {
    AlreadyRunning,
    ControlUnavailable,
    UnsafeControlSocket,
    healthControl,
    notifyControl,
    prepareControlSocket,
    startControlServer,
} from "../../src/plugin/control.ts";
import {
    HookNotification,
    type HookNotification as HookNotificationValue,
} from "../../src/plugin/protocol.ts";
import {
    classifyWindowsPipeOwner,
    currentWindowsUserSid,
    ensureWindowsStateDirectory,
    windowsControlPipePath,
    windowsPipeOwner,
    windowsPipeOwnerSid,
    windowsPipePresence,
} from "../../src/plugin/windows-pipe.ts";

const windowsOnly = process.platform === "win32";
const hasPowerShell =
    windowsOnly &&
    Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]).exitCode === 0;
const windowsTest = test.skipIf(!hasPowerShell);
const windowsOnlyTest = test.skipIf(!windowsOnly);

const hint: HookNotificationValue = Schema.decodeUnknownSync(HookNotification)({
    workspaceId: "ws-1",
    cwd: "C:\\src\\project",
});

const uniquePipe = (): string =>
    windowsControlPipePath(randomUUID().replaceAll("-", "").slice(0, 16));

/** P/Invoke helper: open a kernel object and render its owner/DACL as SDDL. */
const SDDL_HELPER = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KernelAcl {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern uint GetSecurityInfo(IntPtr handle, int objectType, uint securityInfo, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint info, out IntPtr text, out uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
    public static string Describe(string name) {
        IntPtr handle = CreateFileW(name, 0x00020000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (handle == new IntPtr(-1)) { return "OPEN_FAILED:" + Marshal.GetLastWin32Error(); }
        try {
            IntPtr owner, group, dacl, sacl, descriptor;
            uint result = GetSecurityInfo(handle, 6, 0x00000005, out owner, out group, out dacl, out sacl, out descriptor);
            if (result != 0) { return "SECURITY_FAILED:" + result; }
            IntPtr text; uint length;
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 0x00000005, out text, out length)) { return "SDDL_FAILED:" + Marshal.GetLastWin32Error(); }
            return Marshal.PtrToStringUni(text);
        } finally { CloseHandle(handle); }
    }
}
'@
`;

const runPowerShell = async (script: string): Promise<string> => {
    const child = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (exitCode !== 0) {
        throw new Error(`pwsh failed (${exitCode}): ${stderr.slice(0, 512)}`);
    }
    return stdout.trim();
};

const pipeSddl = async (path: string): Promise<string> =>
    (await runPowerShell(`${SDDL_HELPER}\nWrite-Output ([KernelAcl]::Describe('${path}'))`)).trim();

const directorySddl = async (path: string): Promise<string> =>
    (await runPowerShell(`Write-Output ((Get-Acl -LiteralPath '${path}').Sddl)`)).trim();

const currentUserSid = async (): Promise<string> =>
    (
        await runPowerShell(
            "Write-Output ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
        )
    ).trim();

windowsTest(
    "grants pipe write access only to the daemon owner",
    async () => {
        const path = uniquePipe();
        const published: Array<HookNotification> = [];
        const server = await startControlServer({
            path,
            paneId: "pane-1",
            notifications: {
                publish(notification) {
                    published.push(notification);
                },
            },
        });
        try {
            const sddl = await pipeSddl(path);
            const sid = await currentUserSid();

            expect(sddl).toContain("(A;;FA;;;SY)");
            expect(sddl).toContain("(A;;FA;;;BA)");
            expect(sddl).toContain(`(A;;FA;;;${sid})`);
            // Everyone and Anonymous may only read: writing is what a control
            // request requires, so the kernel rejects their connections.
            for (const match of sddl.matchAll(/\(A;[^)]*;;;WD\)/g)) {
                expect(match[0]).toContain(";FR;");
            }
            for (const match of sddl.matchAll(/\(A;[^)]*;;;AN\)/g)) {
                expect(match[0]).toContain(";FR;");
            }
        } finally {
            await server.close();
        }
    },
    20_000,
);

test("compares pipe owner SIDs against the current account", () => {
    // Pure decision table, so the foreign-owner refusal stays covered even where
    // no second Windows account is available to create a foreign-owned pipe.
    expect(classifyWindowsPipeOwner("S-1-5-21-1", "S-1-5-21-1")).toBe("own");
    expect(classifyWindowsPipeOwner("S-1-5-21-1", "S-1-5-21-2")).toBe("foreign");
    expect(classifyWindowsPipeOwner(undefined, "S-1-5-21-1")).toBe("unavailable");
    expect(classifyWindowsPipeOwner("S-1-5-21-1", undefined)).toBe("unverified");
});

windowsTest("verifies the serving pipe owner before writing a request", async () => {
    const path = uniquePipe();
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: { publish() {} },
    });
    try {
        const userSid = currentWindowsUserSid();
        expect(userSid).toMatch(/^S-1-5-/);
        expect(userSid).toBe(await currentUserSid());
        expect(windowsPipeOwnerSid(path)).toBe(userSid as string);
        expect(windowsPipeOwner(path)).toBe("own");
        // A pipe owned by any other account must never receive request bytes.
        expect(windowsPipeOwner(path, "S-1-5-18")).toBe("foreign");
    } finally {
        await server.close();
    }
    expect(windowsPipeOwner(path)).toBe("unavailable");
});

windowsOnlyTest(
    "documents that a listening same-account squatter receives hints and can forge responses",
    async () => {
        const path = uniquePipe();
        const received: string[] = [];
        // Known limitation of the shipped Windows model, asserted so it can never
        // be mistaken for impersonation resistance: a squatter created by this
        // account is indistinguishable from the daemon through the owner check.
        // Windows support assumes a trusted local account/host; see windows-pipe.ts.
        let forgeResponses = false;
        const squatter = Bun.listen<undefined>({
            unix: path,
            socket: {
                data(socket, chunk) {
                    received.push(new TextDecoder().decode(chunk));
                    if (forgeResponses) {
                        socket.end('{"ok":true}\n');
                    }
                },
                open() {},
                end() {},
            },
        });
        try {
            await Bun.sleep(20);
            expect(await windowsPipePresence(path)).toBe("present");
            expect(windowsPipeOwner(path)).toBe("own");

            // Duplicate-daemon safety: Bun binds with FILE_FLAG_FIRST_PIPE_INSTANCE,
            // so an actively listening holder makes the daemon fail closed.
            await expect(
                startControlServer({ path, paneId: null, notifications: { publish() {} } }),
            ).rejects.toBeInstanceOf(AlreadyRunning);
            await expect(prepareControlSocket(path)).rejects.toBeInstanceOf(AlreadyRunning);

            // The cwd hint reaches the squatter: the listener captures the frame.
            await expect(notifyControl(path, hint, 300)).rejects.toBeInstanceOf(ControlUnavailable);
            expect(received.join("")).toContain("ws-1");

            // And a forged success frame is accepted, because responses are only
            // shape-checked. A same-account attacker can therefore impersonate the
            // daemon; that is the trusted-local-host assumption of this release.
            forgeResponses = true;
            await notifyControl(path, hint, 300);
            expect(received.join("")).toContain("ws-1");
        } finally {
            squatter.stop(true);
        }
    },
);

windowsTest("creates the hook lock directory inside the user profile ACL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zed-herdr-state-"));
    try {
        const stateDirectory = join(directory, "zed-herdr", "locks");
        await ensureWindowsStateDirectory(stateDirectory);
        const sddl = await directorySddl(stateDirectory);
        const sid = await currentUserSid();

        expect(sddl).toContain(sid);
        // No inherited or explicit grant to Everyone/Anonymous means only the
        // owner (plus SYSTEM/Administrators) can create or replace the lock.
        expect(sddl).not.toMatch(/;;;(WD|AN)\)/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

windowsTest(
    "fails closed when a permissive foreign pipe holds the name",
    async () => {
        const path = uniquePipe();
        const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Squatter {
    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES { public uint nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint instances, uint outSize, uint inSize, uint timeout, ref SECURITY_ATTRIBUTES attributes);
    public static string Create(string name) {
        IntPtr descriptor; uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("D:(A;;FA;;;WD)", 1, out descriptor, out size)) { return "SDDL_FAILED:" + Marshal.GetLastWin32Error(); }
        var attributes = new SECURITY_ATTRIBUTES { nLength = (uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), lpSecurityDescriptor = descriptor, bInheritHandle = false };
        IntPtr handle = CreateNamedPipeW(name, 3, 0, 1, 4096, 4096, 0, ref attributes);
        if (handle == new IntPtr(-1)) { return "CREATE_FAILED:" + Marshal.GetLastWin32Error(); }
        return "OK";
    }
}
'@
Write-Output ([Squatter]::Create('${path}'))
Write-Output 'ready'
Start-Sleep -Seconds 15
`;
        const child = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        try {
            const reader = child.stdout.getReader();
            const decoder = new TextDecoder();
            let seen = "";
            while (!seen.includes("ready")) {
                const chunk = await reader.read();
                if (chunk.done) {
                    break;
                }
                seen += decoder.decode(chunk.value, { stream: true });
            }
            expect(seen).toContain("OK");
            expect(await windowsPipePresence(path)).not.toBe("absent");

            // A squatted pipe is occupied, never reusable: refuse to bind and never
            // delete the foreign name, with a bounded probe instead of a hang.
            await expect(
                startControlServer({
                    path,
                    paneId: null,
                    notifications: { publish() {} },
                }),
            ).rejects.toBeInstanceOf(UnsafeControlSocket);
            await expect(prepareControlSocket(path)).rejects.toBeInstanceOf(UnsafeControlSocket);
            await expect(healthControl(path, 200)).rejects.toMatchObject({ operation: "connect" });
        } finally {
            child.kill("SIGKILL");
            await child.exited;
        }
    },
    20_000,
);
