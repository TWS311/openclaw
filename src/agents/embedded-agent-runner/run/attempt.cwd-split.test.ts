// Coverage for keeping attempt workspace and runtime cwd distinct.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

describe("runEmbeddedAttempt cwd/workspace split", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it("uses workspace for bootstrap and cwd for runtime tools", async () => {
    // Bootstrap still reads the agent workspace, while coding tools execute in
    // the task repo cwd when a subagent targets a separate checkout.
    const bootstrap = createContextEngineBootstrapAndAssemble();
    const taskRepo = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-task-repo-"));
    tempPaths.push(taskRepo);

    await createContextEngineAttemptRunner({
      contextEngine: bootstrap,
      sessionKey: "agent:main:subagent:child",
      tempPaths,
      attemptOverrides: {
        cwd: taskRepo,
        disableTools: false,
      },
    });

    const bootstrapCall = hoisted.resolveBootstrapFilesForRunMock.mock.calls[0]?.[0] as
      | { agentId?: string; workspaceDir?: string }
      | undefined;
    expect(bootstrapCall?.workspaceDir).not.toBe("/tmp/task-repo");
    expect(bootstrapCall?.agentId).toBe("main");

    const toolsCall = hoisted.createOpenClawCodingToolsMock.mock.calls[0]?.[0] as
      | { cwd?: string; workspaceDir?: string; spawnWorkspaceDir?: string }
      | undefined;
    expect(toolsCall?.cwd).toBe(taskRepo);
    expect(toolsCall?.workspaceDir).toBe(bootstrapCall?.workspaceDir);
    expect(toolsCall?.spawnWorkspaceDir).toBe(bootstrapCall?.workspaceDir);

    const resourceLoaderInit = hoisted.defaultResourceLoaderInitMock.mock.calls[0]?.[0] as
      | { cwd?: string }
      | undefined;
    expect(resourceLoaderInit?.cwd).toBe(taskRepo);
  });

  it("forwards native and routable channel targets into runtime tools", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:slack:direct:U123",
      tempPaths,
      attemptOverrides: {
        currentChannelId: "D123",
        currentMessagingTarget: "user:U123",
        disableTools: false,
      },
    });

    const toolsCall = hoisted.createOpenClawCodingToolsMock.mock.calls[0]?.[0] as
      | { currentChannelId?: string; currentMessagingTarget?: string }
      | undefined;
    expect(toolsCall).toMatchObject({
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
    });
  });

  it("uses sandbox cwd overrides when they stay inside the effective workspace", async () => {
    const sandboxWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-copy-"));
    const sandboxTaskRepo = path.join(sandboxWorkspace, "worktrees", "task-1");
    tempPaths.push(sandboxWorkspace);
    await fs.mkdir(sandboxTaskRepo, { recursive: true });
    hoisted.resolveSandboxContextMock.mockResolvedValueOnce({
      enabled: true,
      workspaceAccess: "ro",
      workspaceDir: sandboxWorkspace,
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:subagent:child",
      tempPaths,
      attemptOverrides: {
        cwd: sandboxTaskRepo,
        disableTools: false,
      },
    });

    const toolsCall = hoisted.createOpenClawCodingToolsMock.mock.calls[0]?.[0] as
      | { cwd?: string; workspaceDir?: string }
      | undefined;
    expect(toolsCall?.workspaceDir).toBe(sandboxWorkspace);
    expect(toolsCall?.cwd).toBe(sandboxTaskRepo);
  });

  it("rejects sandbox cwd overrides that escape the effective workspace", async () => {
    const sandboxWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-copy-"));
    const outsideRepo = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-outside-repo-"));
    tempPaths.push(sandboxWorkspace, outsideRepo);
    hoisted.resolveSandboxContextMock.mockResolvedValueOnce({
      enabled: true,
      workspaceAccess: "ro",
      workspaceDir: sandboxWorkspace,
    });

    await expect(
      createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:subagent:child",
        tempPaths,
        attemptOverrides: {
          cwd: outsideRepo,
        },
      }),
    ).rejects.toThrow("must stay inside the effective sandbox workspace");
    expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
  });
});
