// Control UI sidebar session list tests cover local dashboard workflow state.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";
import {
  loadSidebarSessionList,
  renderSidebarSessionList,
  resolveSidebarSessionListEntries,
  selectSidebarSessionAgentFilter,
  selectSidebarSessionListTab,
  toggleSidebarPinnedSession,
} from "./sidebar-session-list.ts";

function row(overrides: Partial<GatewaySessionRow> & { key: string }): GatewaySessionRow {
  return {
    key: overrides.key,
    kind: "direct",
    updatedAt: 0,
    ...overrides,
  };
}

function sessions(rows: GatewaySessionRow[], extra: Partial<SessionsListResult> = {}) {
  return {
    ts: 0,
    path: "",
    count: rows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: rows,
    ...extra,
  } satisfies SessionsListResult;
}

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  let state = {
    settings: {
      gatewayUrl: "ws://localhost:18789",
      token: "",
      locale: "en",
      sessionKey: "agent:main:current",
      lastActiveSessionKey: "agent:main:current",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navWidth: 280,
      navCollapsed: false,
      navGroupsCollapsed: {},
      recentSessionsCollapsed: false,
      sidebarPinnedSessionKeys: [],
      sidebarSessionListTab: "archived",
      sidebarSessionActiveOnly: false,
      borderRadius: 50,
      textScale: 100,
      chatShowThinking: true,
      chatShowToolCalls: true,
      chatPersistCommentary: false,
      chatAutoScroll: "near-bottom",
    },
    sessionKey: "agent:main:current",
    assistantAgentId: "main",
    agentsList: {
      defaultId: "main",
      agents: [
        { id: "main", name: "Main" },
        { id: "ops", name: "Ops" },
      ],
    },
    hello: null,
    basePath: "",
    connected: true,
    client: null,
    chatLoading: false,
    chatSending: false,
    chatRunId: null,
    chatStream: null,
    sessionsLoading: false,
    sessionsError: null,
    sessionsFilterActive: "0",
    sessionsFilterLimit: "50",
    sessionsIncludeGlobal: true,
    sessionsIncludeUnknown: true,
    sessionsShowArchived: false,
    sessionsExpandedCheckpointKey: null,
    sessionsCheckpointItemsByKey: {},
    sessionsCheckpointLoadingKey: null,
    sessionsCheckpointBusyKey: null,
    sessionsCheckpointErrorByKey: {},
    sessionsResult: sessions([]),
    sidebarSessionSearchQuery: "",
    sidebarSessionSearchAppliedQuery: "",
    sidebarSessionAgentFilterId: "__all__",
    sidebarSessionListLoading: false,
    sidebarSessionListError: null,
    sidebarSessionListResult: null,
    sidebarSessionListResultAgentFilterId: null,
    requestUpdate: vi.fn(),
    setTab: vi.fn(),
    applySettings: vi.fn((nextSettings: AppViewState["settings"]) => {
      state.settings = nextSettings;
    }),
    ...overrides,
  } as unknown as AppViewState;
  return state;
}

describe("sidebar session list", () => {
  it("filters all sessions to the selected agent and excludes non-chat rows", () => {
    const state = createState({
      sessionKey: "agent:main:current",
      sidebarSessionAgentFilterId: "main",
      settings: {
        ...createState().settings,
        sidebarSessionListTab: "recent",
      },
      sessionsResult: sessions([
        row({ key: "global", kind: "global", label: "Global", updatedAt: 70 }),
        row({ key: "unknown", kind: "unknown", label: "Unknown", updatedAt: 65 }),
        row({ key: "cron:daily", kind: "cron", label: "Cron", updatedAt: 60 }),
        row({
          key: "agent:main:subagent:task",
          label: "Subagent",
          spawnedBy: "agent:main:current",
          updatedAt: 55,
        }),
        row({ key: "agent:ops:second", label: "Ops", updatedAt: 50 }),
        row({ key: "agent:main:archived", label: "Archived", archived: true, updatedAt: 45 }),
        row({ key: "agent:main:older", label: "Main older", updatedAt: 20 }),
        row({ key: "agent:main:newer", label: "Main newer", updatedAt: 40 }),
      ]),
    });

    expect(resolveSidebarSessionListEntries(state).map((entry) => entry.label)).toEqual([
      "Main newer",
      "Main older",
    ]);
  });

  it("shows regular sessions across agents when the sidebar agent filter is all", () => {
    const state = createState({
      settings: {
        ...createState().settings,
        sidebarSessionListTab: "recent",
      },
      sessionsResult: sessions([
        row({ key: "agent:main:older", label: "Main older", updatedAt: 20 }),
        row({ key: "agent:ops:newer", label: "Ops newer", updatedAt: 40 }),
        row({ key: "agent:main:archived", label: "Archived", archived: true, updatedAt: 60 }),
        row({ key: "cron:daily", kind: "cron", label: "Cron", updatedAt: 70 }),
      ]),
    });

    expect(resolveSidebarSessionListEntries(state).map((entry) => entry.label)).toEqual([
      "Ops newer",
      "Main older",
    ]);
  });

  it("renders only resolved local pinned sessions in the pinned tab", () => {
    const state = createState({
      settings: {
        ...createState().settings,
        sidebarPinnedSessionKeys: [
          "agent:main:older",
          "agent:main:missing",
          "agent:main:newer",
        ],
        sidebarSessionListTab: "pinned",
      },
      sessionsResult: sessions([
        row({ key: "agent:main:older", label: "Older", updatedAt: 10 }),
        row({ key: "agent:main:newer", label: "Newer", updatedAt: 20 }),
      ]),
    });

    expect(resolveSidebarSessionListEntries(state).map((entry) => entry.label)).toEqual([
      "Newer",
      "Older",
    ]);

    toggleSidebarPinnedSession(state, "agent:main:older");
    expect(state.applySettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sidebarPinnedSessionKeys: ["agent:main:missing", "agent:main:newer"],
      }),
    );
  });

  it("shows running tab rows using session active run flags", () => {
    const state = createState({
      settings: {
        ...createState().settings,
        sidebarSessionListTab: "archived",
      },
      sessionsResult: sessions([
        row({ key: "agent:main:idle", label: "Idle", updatedAt: 30 }),
        row({ key: "agent:main:run", label: "Run", hasActiveRun: true, updatedAt: 20 }),
        row({
          key: "agent:main:subagent-run",
          label: "Subagent run",
          hasActiveSubagentRun: true,
          updatedAt: 10,
        }),
      ]),
    });

    expect(resolveSidebarSessionListEntries(state).map((entry) => entry.label)).toEqual([
      "Run",
      "Subagent run",
    ]);
  });

  it("hides the shown count footer when there are no sidebar sessions", () => {
    const state = createState({ sessionsResult: sessions([]) });
    const container = document.createElement("div");

    render(
      renderSidebarSessionList(state, {
        collapsed: false,
        onNewSession: () => undefined,
        onSwitchSession: vi.fn(),
      }),
      container,
    );

    expect(container.querySelector(".sidebar-session-footerline")).toBeNull();
    expect(container.textContent).not.toContain("0 shown");
  });

  it("uses the running tab without affecting the all sessions source list", () => {
    const state = createState({
      settings: {
        ...createState().settings,
        sidebarSessionListTab: "archived",
      },
      sessionsResult: sessions([
        row({ key: "agent:main:idle", label: "Idle", updatedAt: 50 }),
        row({ key: "agent:main:run", label: "Run", hasActiveRun: true, updatedAt: 30 }),
      ]),
      sidebarSessionListResultAgentFilterId: "__all__",
      sidebarSessionListResult: sessions([
        row({ key: "agent:main:idle-newer", label: "Idle newer", updatedAt: 40 }),
        row({ key: "agent:main:run-newer", label: "Run newer", hasActiveRun: true, updatedAt: 35 }),
        row({
          key: "agent:main:run-older",
          label: "Run older",
          hasActiveSubagentRun: true,
          updatedAt: 20,
        }),
      ]),
    });

    expect(resolveSidebarSessionListEntries(state).map((entry) => entry.label)).toEqual([
      "Run newer",
      "Run older",
    ]);

    selectSidebarSessionListTab(state, "recent");
    expect(resolveSidebarSessionListEntries(state).map((entry) => entry.label)).toEqual([
      "Idle",
      "Run",
    ]);
  });

  it("loads running search results through sessions.list and keeps search transient", async () => {
    const request = vi.fn(async () =>
      sessions([row({ key: "agent:main:running", label: "Running", hasActiveRun: true })]),
    );
    const state = createState({
      settings: {
        ...createState().settings,
        sidebarSessionListTab: "archived",
      },
      client: { request } as unknown as AppViewState["client"],
    });

    await loadSidebarSessionList(state, { query: "release", tab: "archived" });

    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({
        configuredAgentsOnly: true,
        includeGlobal: true,
        includeUnknown: true,
        limit: 50,
        search: "release",
      }),
    );
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("agentId");
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("activeMinutes");
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("showArchived");
    expect(state.sidebarSessionSearchAppliedQuery).toBe("release");
    expect(state.sidebarSessionListResultAgentFilterId).toBe("__all__");
    expect(state.settings.sidebarSessionListTab).toBe("archived");
  });

  it("renders agent filter options as plain agent names without a leading icon", () => {
    const state = createState({
      agentsList: {
        defaultId: "main",
        agents: [
          { id: "main", name: "Main Agent" },
          { id: "ops", identity: { name: "Operations" }, name: "Ops" },
        ],
      } as AppViewState["agentsList"],
    });
    const container = document.createElement("div");

    render(
      renderSidebarSessionList(state, {
        collapsed: false,
        onNewSession: () => undefined,
        onSwitchSession: vi.fn(),
      }),
      container,
    );

    expect(container.querySelector(".sidebar-session-agent-filter__icon")).toBeNull();
    expect(
      Array.from(container.querySelectorAll<HTMLOptionElement>("option")).map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(["All agents", "Main Agent", "Operations"]);
  });

  it("loads sidebar rows with the selected agent filter when requested", async () => {
    const request = vi.fn(async () =>
      sessions([row({ key: "agent:ops:main", label: "Ops" })]),
    );
    const state = createState({
      client: { request } as unknown as AppViewState["client"],
    });

    selectSidebarSessionAgentFilter(state, "ops");
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId: "ops" }),
      );
    });
    expect(state.sidebarSessionAgentFilterId).toBe("ops");
    expect(state.sidebarSessionListResultAgentFilterId).toBe("ops");
  });

  it("renders a functional more-actions menu for sidebar rows", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return { ok: true, deleted: true };
      }
      if (method === "sessions.list") {
        return sessions([]);
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as AppViewState["client"],
      settings: {
        ...createState().settings,
        sidebarSessionListTab: "recent",
      },
      sessionsResult: sessions([row({ key: "agent:main:alpha", label: "Alpha" })]),
    });
    const container = document.createElement("div");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    if (!("execCommand" in document)) {
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: () => false,
      });
    }
    const copySpy = vi
      .spyOn(document, "execCommand")
      .mockImplementation((command) => command === "copy");

    render(
      renderSidebarSessionList(state, {
        collapsed: false,
        onNewSession: () => undefined,
        onSwitchSession: vi.fn(),
      }),
      container,
    );

    const menu = container.querySelector<HTMLDetailsElement>(".sidebar-session-menu");
    expect(menu).toBeInstanceOf(HTMLDetailsElement);
    menu?.setAttribute("open", "");

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".sidebar-session-menu__item"),
    );
    expect(buttons.map((button) => button.textContent?.trim())).toContain("Copy session key");
    expect(buttons.map((button) => button.textContent?.trim())).toContain("Delete");
    expect(container.querySelector('button[title="Pin session"]')).toBeNull();

    buttons.find((button) => button.textContent?.includes("Copy session key"))?.click();
    expect(copySpy).toHaveBeenCalledWith("copy");

    buttons.find((button) => button.textContent?.includes("Pin session"))?.click();
    expect(state.applySettings).toHaveBeenCalledWith(
      expect.objectContaining({ sidebarPinnedSessionKeys: ["agent:main:alpha"] }),
    );

    buttons.find((button) => button.textContent?.includes("Delete"))?.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("sessions.delete", {
        key: "agent:main:alpha",
        deleteTranscript: true,
      });
    });
    expect(confirmSpy).toHaveBeenCalled();

    confirmSpy.mockRestore();
    copySpy.mockRestore();
  });
});
