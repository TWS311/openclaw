// Control UI chat module implements sidebar session list behavior.
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../i18n/index.ts";
import {
  createChatSessionsLoadOverrides,
  hasAbortableSessionRun,
} from "../app-chat.ts";
import type { AppViewState } from "../app-view-state.ts";
import { deleteSessionsAndRefresh } from "../controllers/sessions.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { pathForTab } from "../navigation.ts";
import { resolveSessionDisplayName, isCronSessionKey } from "../session-display.ts";
import {
  areUiSessionKeysEquivalent,
  isSessionKeyTiedToAgent,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
} from "../session-key.ts";
import {
  normalizeSidebarSessionListTab,
  type SidebarSessionListTab,
} from "../storage.ts";
import { normalizeOptionalString } from "../string-coerce.ts";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";
import { copyToClipboard } from "./clipboard.ts";
import { renderChatSessionSelect } from "./session-controls.ts";

type SidebarSessionSwitchHandler = (state: AppViewState, nextSessionKey: string) => void;

type SidebarSessionListController = {
  activeRequestId: number | null;
  activeRequestSignature: string | null;
  nextRequestId: number;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
};

export type SidebarSessionListEntry = {
  active: boolean;
  agentLabel: string;
  label: string;
  meta: string;
  pinned: boolean;
  row: GatewaySessionRow;
  running: boolean;
};

const SIDEBAR_SESSION_SEARCH_DEBOUNCE_MS = 300;
const SIDEBAR_ALL_AGENTS_FILTER_ID = "__all__";
const SIDEBAR_ALL_SESSIONS_TAB: SidebarSessionListTab = "recent";
const SIDEBAR_RUNNING_SESSIONS_TAB: SidebarSessionListTab = "archived";
const sidebarSessionListControllers = new WeakMap<
  AppViewState,
  SidebarSessionListController
>();

function resolveSidebarSessionListTab(state: AppViewState): SidebarSessionListTab {
  return normalizeSidebarSessionListTab(state.settings.sidebarSessionListTab);
}

function resolvePinnedSessionKeys(state: AppViewState): string[] {
  return Array.isArray(state.settings.sidebarPinnedSessionKeys)
    ? state.settings.sidebarPinnedSessionKeys
    : [];
}

function resolveSidebarAgentFilterId(state: AppViewState): string {
  const raw = normalizeOptionalString(state.sidebarSessionAgentFilterId);
  if (!raw || raw === SIDEBAR_ALL_AGENTS_FILTER_ID) {
    return SIDEBAR_ALL_AGENTS_FILTER_ID;
  }
  return normalizeAgentId(raw);
}

function getSidebarSessionListController(state: AppViewState): SidebarSessionListController {
  let controller = sidebarSessionListControllers.get(state);
  if (!controller) {
    controller = {
      activeRequestId: null,
      activeRequestSignature: null,
      nextRequestId: 0,
      timer: null,
    };
    sidebarSessionListControllers.set(state, controller);
  }
  return controller;
}

function requestHostUpdate(state: AppViewState) {
  (state as AppViewState & { requestUpdate?: () => void }).requestUpdate?.();
}

function clearSidebarSessionSearchTimer(state: AppViewState) {
  const controller = getSidebarSessionListController(state);
  if (controller.timer) {
    globalThis.clearTimeout(controller.timer);
    controller.timer = null;
  }
}

function beginSidebarSessionListRequest(state: AppViewState, signature: string): number | null {
  const controller = getSidebarSessionListController(state);
  if (controller.activeRequestSignature === signature) {
    return null;
  }
  controller.nextRequestId += 1;
  controller.activeRequestId = controller.nextRequestId;
  controller.activeRequestSignature = signature;
  return controller.activeRequestId;
}

function isCurrentSidebarSessionListRequest(state: AppViewState, requestId: number): boolean {
  return getSidebarSessionListController(state).activeRequestId === requestId;
}

function finishSidebarSessionListRequest(state: AppViewState, requestId: number) {
  if (!isCurrentSidebarSessionListRequest(state, requestId)) {
    return;
  }
  const controller = getSidebarSessionListController(state);
  controller.activeRequestId = null;
  controller.activeRequestSignature = null;
}

function createSidebarRequestSignature(options: {
  agentFilterId: string;
  append?: boolean;
  offset?: number;
  query: string;
  tab: SidebarSessionListTab;
}) {
  return [
    options.tab,
    options.agentFilterId,
    options.query,
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0,
    options.append === true ? "append" : "replace",
  ].join("\n");
}

function resolveNextSidebarSessionOffset(
  sessions: SessionsListResult | null | undefined,
): number | null {
  if (!sessions?.hasMore) {
    return null;
  }
  if (typeof sessions.nextOffset === "number" && Number.isFinite(sessions.nextOffset)) {
    return Math.max(0, Math.floor(sessions.nextOffset));
  }
  return sessions.sessions.length;
}

function appendSidebarSessionListResult(
  previous: SessionsListResult,
  page: SessionsListResult,
): SessionsListResult {
  const rowsByKey = new Map(previous.sessions.map((row) => [row.key, row] as const));
  const sessions = [...previous.sessions];
  for (const row of page.sessions) {
    if (rowsByKey.has(row.key)) {
      continue;
    }
    rowsByKey.set(row.key, row);
    sessions.push(row);
  }
  return {
    ...page,
    count: sessions.length,
    sessions,
    totalCount: page.totalCount ?? previous.totalCount,
  };
}

function createSidebarSessionListRequestParams(
  options: {
    agentFilterId: string;
    offset?: number;
    query: string;
    tab: SidebarSessionListTab;
  },
): Record<string, unknown> {
  const overrides = createChatSessionsLoadOverrides(
    { sessionsShowArchived: false },
    { offset: options.offset, search: options.query },
  );
  const params: Record<string, unknown> = {
    includeGlobal: overrides.includeGlobal,
    includeUnknown: overrides.includeUnknown,
    configuredAgentsOnly: overrides.configuredAgentsOnly,
    limit: overrides.limit,
  };
  if (options.agentFilterId !== SIDEBAR_ALL_AGENTS_FILTER_ID) {
    params.agentId = normalizeAgentId(options.agentFilterId);
  }
  const offset =
    typeof overrides.offset === "number" && Number.isFinite(overrides.offset)
      ? Math.max(0, Math.floor(overrides.offset))
      : 0;
  if (offset > 0) {
    params.offset = offset;
  }
  const search = normalizeOptionalString(overrides.search);
  if (search) {
    params.search = search;
  }
  if (typeof overrides.activeMinutes === "number" && overrides.activeMinutes > 0) {
    params.activeMinutes = overrides.activeMinutes;
  }
  return params;
}

export async function loadSidebarSessionList(
  state: AppViewState,
  options: {
    agentFilterId?: string;
    append?: boolean;
    offset?: number;
    query?: string;
    tab?: SidebarSessionListTab;
  } = {},
): Promise<SessionsListResult | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const tab = options.tab ?? resolveSidebarSessionListTab(state);
  const agentFilterId =
    options.agentFilterId == null
      ? resolveSidebarAgentFilterId(state)
      : options.agentFilterId === SIDEBAR_ALL_AGENTS_FILTER_ID
        ? SIDEBAR_ALL_AGENTS_FILTER_ID
        : normalizeAgentId(options.agentFilterId);
  const query = normalizeOptionalString(options.query ?? state.sidebarSessionSearchQuery) ?? "";
  const requestId = beginSidebarSessionListRequest(
    state,
    createSidebarRequestSignature({
      agentFilterId,
      append: options.append,
      offset: options.offset,
      query,
      tab,
    }),
  );
  if (requestId === null) {
    return null;
  }
  state.sidebarSessionListLoading = true;
  state.sidebarSessionListError = null;
  requestHostUpdate(state);
  try {
    const page = await state.client.request<SessionsListResult>(
      "sessions.list",
      createSidebarSessionListRequestParams({
        agentFilterId,
        offset: options.offset,
        query,
        tab,
      }),
    );
    if (!isCurrentSidebarSessionListRequest(state, requestId)) {
      return null;
    }
    const previous = state.sidebarSessionListResult ?? state.sessionsResult;
    state.sidebarSessionListResult =
      options.append === true && previous
        ? appendSidebarSessionListResult(previous, page)
        : page;
    state.sidebarSessionListResultAgentFilterId = agentFilterId;
    state.sidebarSessionSearchAppliedQuery = query;
    return state.sidebarSessionListResult;
  } catch (err) {
    if (!isCurrentSidebarSessionListRequest(state, requestId)) {
      return null;
    }
    state.sidebarSessionListError = String(err);
    return null;
  } finally {
    if (isCurrentSidebarSessionListRequest(state, requestId)) {
      finishSidebarSessionListRequest(state, requestId);
      state.sidebarSessionListLoading = false;
      requestHostUpdate(state);
    }
  }
}

function clearSidebarSessionRemoteResult(state: AppViewState) {
  state.sidebarSessionSearchAppliedQuery = "";
  state.sidebarSessionListError = null;
  state.sidebarSessionListLoading = false;
  state.sidebarSessionListResult = null;
  state.sidebarSessionListResultAgentFilterId = null;
}

export function updateSidebarSessionSearchQuery(state: AppViewState, nextQuery: string) {
  state.sidebarSessionSearchQuery = nextQuery;
  clearSidebarSessionSearchTimer(state);
  const query = normalizeOptionalString(nextQuery) ?? "";
  if (!query) {
    state.sidebarSessionSearchAppliedQuery = "";
    void loadSidebarSessionList(state, { query: "" });
    requestHostUpdate(state);
    return;
  }
  const controller = getSidebarSessionListController(state);
  controller.timer = globalThis.setTimeout(() => {
    controller.timer = null;
    void loadSidebarSessionList(state, { query });
  }, SIDEBAR_SESSION_SEARCH_DEBOUNCE_MS);
  requestHostUpdate(state);
}

export function selectSidebarSessionListTab(state: AppViewState, tab: SidebarSessionListTab) {
  state.applySettings({ ...state.settings, sidebarSessionListTab: tab });
  clearSidebarSessionRemoteResult(state);
  void loadSidebarSessionList(state, { tab });
  requestHostUpdate(state);
}

export function selectSidebarSessionAgentFilter(state: AppViewState, agentFilterId: string) {
  const next =
    agentFilterId === SIDEBAR_ALL_AGENTS_FILTER_ID
      ? SIDEBAR_ALL_AGENTS_FILTER_ID
      : normalizeAgentId(agentFilterId);
  if (next === resolveSidebarAgentFilterId(state)) {
    return;
  }
  state.sidebarSessionAgentFilterId = next;
  clearSidebarSessionRemoteResult(state);
  void loadSidebarSessionList(state, { agentFilterId: next });
  requestHostUpdate(state);
}

export function toggleSidebarPinnedSession(state: AppViewState, sessionKey: string) {
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return;
  }
  const current = resolvePinnedSessionKeys(state);
  const next = current.includes(key)
    ? current.filter((entry) => entry !== key)
    : [key, ...current.filter((entry) => entry !== key)].slice(0, 50);
  state.applySettings({ ...state.settings, sidebarPinnedSessionKeys: next });
}

function closeSidebarSessionMenu(event: Event) {
  const target = event.currentTarget;
  if (!(target instanceof Element)) {
    return;
  }
  target.closest("details")?.removeAttribute("open");
}

async function copySidebarSessionKey(state: AppViewState, sessionKey: string) {
  const copied = await copyToClipboard(sessionKey);
  if (!copied) {
    state.sidebarSessionListError = t("chat.selectors.copySessionKeyFailed");
  } else if (state.sidebarSessionListError === t("chat.selectors.copySessionKeyFailed")) {
    state.sidebarSessionListError = null;
  }
  requestHostUpdate(state);
}

function removeSidebarRowsFromResult(
  result: SessionsListResult | null,
  deletedKeys: Set<string>,
): SessionsListResult | null {
  if (!result || deletedKeys.size === 0) {
    return result;
  }
  const sessions = result.sessions.filter((row) => !deletedKeys.has(row.key));
  return {
    ...result,
    count: sessions.length,
    sessions,
    totalCount:
      typeof result.totalCount === "number"
        ? Math.max(0, result.totalCount - (result.sessions.length - sessions.length))
        : result.totalCount,
  };
}

async function deleteSidebarSession(state: AppViewState, sessionKey: string) {
  const deleted = await deleteSessionsAndRefresh(
    state as unknown as Parameters<typeof deleteSessionsAndRefresh>[0],
    [sessionKey],
  );
  if (deleted.length === 0) {
    requestHostUpdate(state);
    return;
  }
  const deletedKeys = new Set(deleted);
  state.sidebarSessionListResult = removeSidebarRowsFromResult(
    state.sidebarSessionListResult,
    deletedKeys,
  );
  const pinnedKeys = resolvePinnedSessionKeys(state).filter((key) => !deletedKeys.has(key));
  if (pinnedKeys.length !== resolvePinnedSessionKeys(state).length) {
    state.applySettings({ ...state.settings, sidebarPinnedSessionKeys: pinnedKeys });
  }
  if (sidebarResultMatchesCurrentFilter(state)) {
    void loadSidebarSessionList(state);
  }
  requestHostUpdate(state);
}

function isSidebarSessionBusy(state: AppViewState): boolean {
  return (
    state.chatLoading ||
    state.chatSending ||
    Boolean(state.chatRunId) ||
    Boolean(state.chatStream) ||
    hasAbortableSessionRun(state)
  );
}

export function resolveSidebarSelectedAgentId(state: AppViewState): string {
  const parsed = parseAgentSessionKey(state.sessionKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return normalizeAgentId(
    state.sessionKey === "global"
      ? (state.assistantAgentId ?? resolveUiDefaultAgentId(state))
      : resolveUiDefaultAgentId(state),
  );
}

function isSidebarSessionForSelectedAgent(
  state: AppViewState,
  row: GatewaySessionRow,
  agentFilterId: string,
): boolean {
  if (agentFilterId === SIDEBAR_ALL_AGENTS_FILTER_ID) {
    return true;
  }
  return isSessionKeyTiedToAgent(row.key, agentFilterId, resolveUiDefaultAgentId(state));
}

function isBaseSidebarSessionRow(
  state: AppViewState,
  row: GatewaySessionRow,
  agentFilterId: string,
): boolean {
  return (
    !row.archived &&
    row.kind !== "global" &&
    row.kind !== "unknown" &&
    row.kind !== "cron" &&
    !isCronSessionKey(row.key) &&
    !isSubagentSessionKey(row.key) &&
    !row.spawnedBy &&
    isSidebarSessionForSelectedAgent(state, row, agentFilterId)
  );
}

function isSidebarRunningSessionRow(row: GatewaySessionRow): boolean {
  return row.hasActiveRun === true || row.hasActiveSubagentRun === true;
}

function sidebarResultMatchesCurrentFilter(state: AppViewState): boolean {
  return (
    Boolean(state.sidebarSessionListResult) &&
    state.sidebarSessionListResultAgentFilterId === resolveSidebarAgentFilterId(state)
  );
}

function shouldUseSidebarResult(state: AppViewState): boolean {
  if (!sidebarResultMatchesCurrentFilter(state)) {
    return false;
  }
  const query = normalizeOptionalString(state.sidebarSessionSearchQuery) ?? "";
  if (query) {
    return state.sidebarSessionSearchAppliedQuery === query;
  }
  return Boolean(state.sidebarSessionListResult);
}

function resolveKnownSidebarRows(state: AppViewState): GatewaySessionRow[] {
  const rowsByKey = new Map<string, GatewaySessionRow>();
  for (const row of state.sessionsResult?.sessions ?? []) {
    rowsByKey.set(row.key, row);
  }
  for (const row of state.sidebarSessionListResult?.sessions ?? []) {
    rowsByKey.set(row.key, row);
  }
  return [...rowsByKey.values()];
}

function resolveSidebarSourceRows(state: AppViewState): GatewaySessionRow[] {
  if (shouldUseSidebarResult(state)) {
    return state.sidebarSessionListResult?.sessions ?? [];
  }
  return state.sessionsResult?.sessions ?? [];
}

function formatSidebarAgentLabel(state: AppViewState, row: GatewaySessionRow): string {
  const parsed = parseAgentSessionKey(row.key);
  const agentId = normalizeOptionalString(parsed?.agentId);
  if (!agentId) {
    return row.kind;
  }
  const agent = state.agentsList?.agents?.find(
    (entry) => normalizeAgentId(entry.id) === normalizeAgentId(agentId),
  );
  const name =
    normalizeOptionalString(agent?.identity?.name) ?? normalizeOptionalString(agent?.name);
  return name && name !== agentId ? `${name}` : agentId;
}

function toSidebarSessionEntry(
  state: AppViewState,
  row: GatewaySessionRow,
): SidebarSessionListEntry {
  const label = resolveSessionDisplayName(row.key, row);
  const updated = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : t("common.na");
  return {
    active: areUiSessionKeysEquivalent(row.key, state.sessionKey),
    agentLabel: formatSidebarAgentLabel(state, row),
    label,
    meta: updated,
    pinned: resolvePinnedSessionKeys(state).includes(row.key),
    row,
    running: isSidebarRunningSessionRow(row),
  };
}

export function resolveSidebarSessionListEntries(
  state: AppViewState,
): SidebarSessionListEntry[] {
  const agentFilterId = resolveSidebarAgentFilterId(state);
  const sourceRows = resolveSidebarSourceRows(state);
  const tab = resolveSidebarSessionListTab(state);
  const pinnedKeys = resolvePinnedSessionKeys(state);
  const knownRowsByKey = new Map(resolveKnownSidebarRows(state).map((row) => [row.key, row]));
  let rows: GatewaySessionRow[];

  if (tab === "pinned") {
    const queryRows = shouldUseSidebarResult(state)
      ? new Set(sourceRows.map((row) => row.key))
      : null;
    rows = pinnedKeys
      .map((key) => knownRowsByKey.get(key))
      .filter((row): row is GatewaySessionRow => Boolean(row))
      .filter((row) => !queryRows || queryRows.has(row.key))
      .filter((row) => isBaseSidebarSessionRow(state, row, agentFilterId));
  } else if (tab === SIDEBAR_RUNNING_SESSIONS_TAB) {
    rows = sourceRows
      .filter((row) => isBaseSidebarSessionRow(state, row, agentFilterId))
      .filter(isSidebarRunningSessionRow);
  } else {
    rows = sourceRows.filter((row) => isBaseSidebarSessionRow(state, row, agentFilterId));
  }

  return rows
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((row) => toSidebarSessionEntry(state, row));
}

export function resolveSidebarActiveSessionLabel(state: AppViewState): string {
  const row =
    state.sessionsResult?.sessions.find((session) =>
      areUiSessionKeysEquivalent(session.key, state.sessionKey),
    ) ??
    state.sidebarSessionListResult?.sessions.find((session) =>
      areUiSessionKeysEquivalent(session.key, state.sessionKey),
    );
  return resolveSessionDisplayName(state.sessionKey, row);
}

function maybeLoadInitialSidebarRows(state: AppViewState) {
  if (!state.connected || !state.client || state.sidebarSessionListLoading) {
    return;
  }
  if (sidebarResultMatchesCurrentFilter(state) || state.sidebarSessionListError) {
    return;
  }
  void loadSidebarSessionList(state);
}

function renderSidebarTabButton(state: AppViewState, tab: SidebarSessionListTab, label: string) {
  const selected = resolveSidebarSessionListTab(state) === tab;
  return html`
    <button
      class="sidebar-session-tabs__btn ${selected ? "sidebar-session-tabs__btn--active" : ""}"
      type="button"
      role="tab"
      aria-selected=${selected ? "true" : "false"}
      @click=${() => selectSidebarSessionListTab(state, tab)}
    >
      ${label}
    </button>
  `;
}

function resolveSidebarAgentName(state: AppViewState, agentIdRaw: string): string {
  const normalized = normalizeAgentId(agentIdRaw);
  const agent = (state.agentsList?.agents ?? []).find(
    (entry) => normalizeAgentId(entry.id) === normalized,
  );
  return (
    normalizeOptionalString(agent?.identity?.name) ??
    normalizeOptionalString(agent?.name) ??
    normalized
  );
}

function resolveSidebarAgentFilterOptions(state: AppViewState): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  const options: Array<{ id: string; label: string }> = [];
  const add = (agentId: string | null | undefined) => {
    const raw = normalizeOptionalString(agentId);
    if (!raw) {
      return;
    }
    const normalized = normalizeAgentId(raw);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    options.push({ id: normalized, label: resolveSidebarAgentName(state, normalized) });
  };

  add(resolveSidebarSelectedAgentId(state));
  add(state.agentsList?.defaultId ?? "main");
  for (const agent of state.agentsList?.agents ?? []) {
    add(agent.id);
  }
  for (const row of state.sessionsResult?.sessions ?? []) {
    add(parseAgentSessionKey(row.key)?.agentId);
  }

  return options;
}

function renderSidebarAgentFilter(state: AppViewState, controlsDisabled: boolean) {
  const activeAgentFilterId = resolveSidebarAgentFilterId(state);
  const agentOptions = [
    { id: SIDEBAR_ALL_AGENTS_FILTER_ID, label: t("chat.selectors.allAgents") },
    ...resolveSidebarAgentFilterOptions(state),
  ];
  return html`
    <label class="sidebar-session-agent-filter">
      <select
        class="sidebar-session-agent-filter__select"
        aria-label=${t("chat.selectors.agentFilter")}
        .value=${activeAgentFilterId}
        ?disabled=${controlsDisabled}
        @change=${(event: Event) => {
          selectSidebarSessionAgentFilter(state, (event.target as HTMLSelectElement).value);
        }}
      >
        ${repeat(
          agentOptions,
          (entry) => entry.id,
          (entry) => html`
            <option value=${entry.id} ?selected=${entry.id === activeAgentFilterId}>
              ${entry.label}
            </option>
          `,
        )}
      </select>
      <span class="sidebar-session-agent-filter__chevron" aria-hidden="true">
        ${icons.chevronDown}
      </span>
    </label>
  `;
}

function renderSidebarSessionRow(
  state: AppViewState,
  entry: SidebarSessionListEntry,
  onSwitchSession: SidebarSessionSwitchHandler,
) {
  const { row } = entry;
  const href = `${pathForTab("chat", state.basePath)}?session=${encodeURIComponent(row.key)}`;
  const rowClasses = [
    "sidebar-session-row",
    entry.active ? "sidebar-session-row--active" : "",
    entry.running ? "sidebar-session-row--running" : "",
    entry.pinned ? "sidebar-session-row--pinned" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const switchToSession = () => {
    if (!areUiSessionKeysEquivalent(row.key, state.sessionKey)) {
      onSwitchSession(state, row.key);
    }
    state.setTab("chat");
  };
  return html`
    <div
      class=${rowClasses}
      data-session-key=${row.key}
      role="listitem"
    >
      <a
        class="sidebar-session-row__link"
        href=${href}
        title=${`${entry.label} · ${row.key}`}
        @click=${(event: MouseEvent) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          event.preventDefault();
          switchToSession();
        }}
      >
        <span class="sidebar-session-row__rail" aria-hidden="true"></span>
        <span class="sidebar-session-row__body">
          <span class="sidebar-session-row__title">${entry.label}</span>
          <span class="sidebar-session-row__agent">${entry.agentLabel}</span>
          <span class="sidebar-session-row__time">${entry.meta}</span>
        </span>
      </a>
      <details class="sidebar-session-menu">
        <summary
          class="sidebar-session-row__icon-btn sidebar-session-menu__trigger"
          title=${t("chat.selectors.moreSessionActions")}
          aria-label=${t("chat.selectors.moreSessionActions")}
          @click=${(event: MouseEvent) => {
            event.stopPropagation();
          }}
        >
          ${icons.moreHorizontal}
        </summary>
        <div class="sidebar-session-menu__panel" role="menu">
          <button
            class="sidebar-session-menu__item"
            type="button"
            role="menuitem"
            @click=${(event: MouseEvent) => {
              closeSidebarSessionMenu(event);
              switchToSession();
            }}
          >
            <span aria-hidden="true">${icons.messageSquare}</span>
            <span>${t("tabs.chat")}</span>
          </button>
          <button
            class="sidebar-session-menu__item"
            type="button"
            role="menuitem"
            @click=${(event: MouseEvent) => {
              closeSidebarSessionMenu(event);
              state.setTab("sessions");
            }}
          >
            <span aria-hidden="true">${icons.scrollText}</span>
            <span>${t("tabs.sessions")}</span>
          </button>
          <button
            class="sidebar-session-menu__item"
            type="button"
            role="menuitem"
            @click=${(event: MouseEvent) => {
              closeSidebarSessionMenu(event);
              void copySidebarSessionKey(state, row.key);
            }}
          >
            <span aria-hidden="true">${icons.copy}</span>
            <span>${t("chat.selectors.copySessionKey")}</span>
          </button>
          <button
            class="sidebar-session-menu__item"
            type="button"
            role="menuitem"
            @click=${(event: MouseEvent) => {
              closeSidebarSessionMenu(event);
              toggleSidebarPinnedSession(state, row.key);
            }}
          >
            <span aria-hidden="true">${entry.pinned ? icons.pinOff : icons.pin}</span>
            <span>
              ${entry.pinned
                ? t("chat.selectors.unpinSession")
                : t("chat.selectors.pinSession")}
            </span>
          </button>
          <button
            class="sidebar-session-menu__item sidebar-session-menu__item--danger"
            type="button"
            role="menuitem"
            ?disabled=${!state.connected || !state.client || state.sessionsLoading}
            @click=${(event: MouseEvent) => {
              closeSidebarSessionMenu(event);
              void deleteSidebarSession(state, row.key);
            }}
          >
            <span aria-hidden="true">${icons.trash}</span>
            <span>${t("common.delete")}</span>
          </button>
        </div>
      </details>
    </div>
  `;
}

function renderExpandedSidebarSessionList(
  state: AppViewState,
  params: {
    newSessionDisabled: boolean;
    newSessionTitle: string;
    onNewSession: () => void | Promise<void>;
    onSwitchSession: SidebarSessionSwitchHandler;
  },
) {
  maybeLoadInitialSidebarRows(state);
  const entries = resolveSidebarSessionListEntries(state);
  const query = state.sidebarSessionSearchQuery;
  const pagingResult = state.sidebarSessionListResult ?? state.sessionsResult;
  const loadMoreOffset = resolveNextSidebarSessionOffset(pagingResult);
  const controlsDisabled = !state.connected || !state.client;

  return html`
    <section class="sidebar-sessions sidebar-sessions--expanded">
      <div class="sidebar-session-actions">
        <button
          type="button"
          class="sidebar-new-session"
          title=${params.newSessionTitle}
          aria-label=${t("chat.runControls.newSession")}
          ?disabled=${params.newSessionDisabled}
          @click=${() => {
            if (!params.newSessionDisabled) {
              void params.onNewSession();
            }
          }}
        >
          <span class="sidebar-new-session__icon" aria-hidden="true">${icons.plus}</span>
          <span class="sidebar-new-session__label">${t("chat.runControls.newSession")}</span>
        </button>
        <label class="sidebar-session-search">
          <span class="sidebar-session-search__icon" aria-hidden="true">${icons.search}</span>
          <input
            class="sidebar-session-search__input"
            type="search"
            placeholder=${t("chat.selectors.sessionSearch")}
            aria-label=${t("chat.selectors.sessionSearch")}
            .value=${query}
            ?disabled=${controlsDisabled}
            @input=${(event: Event) => {
              updateSidebarSessionSearchQuery(state, (event.target as HTMLInputElement).value);
            }}
          />
        </label>
        ${renderSidebarAgentFilter(state, controlsDisabled)}
      </div>

      <div class="sidebar-session-tabs" role="tablist" aria-label=${t("chat.selectors.session")}>
        ${renderSidebarTabButton(state, SIDEBAR_RUNNING_SESSIONS_TAB, t("sessionsView.statusRunning"))}
        ${renderSidebarTabButton(state, "pinned", t("usage.filters.pinned"))}
        ${renderSidebarTabButton(state, SIDEBAR_ALL_SESSIONS_TAB, t("usage.sessions.all"))}
      </div>

      ${state.sidebarSessionListError
        ? html`<div class="sidebar-session-status" role="alert">
            ${state.sidebarSessionListError}
          </div>`
        : nothing}

      <div class="sidebar-session-list" role="list">
        ${state.sidebarSessionListLoading && entries.length === 0
          ? html`<div class="sidebar-session-status">${t("common.loading")}</div>`
          : nothing}
        ${!state.sidebarSessionListLoading && entries.length === 0
          ? html`<div class="sidebar-session-status">${t("sessionsView.noSessions")}</div>`
          : nothing}
        ${repeat(
          entries,
          (entry) => entry.row.key,
          (entry) => renderSidebarSessionRow(state, entry, params.onSwitchSession),
        )}
      </div>

      ${entries.length > 0 || loadMoreOffset !== null
        ? html`<div class="sidebar-session-footerline">
            ${entries.length > 0
              ? html`<span>${t("usage.sessions.shown", { count: entries.length })}</span>`
              : html`<span></span>`}
            ${loadMoreOffset !== null
              ? html`<button
                  class="sidebar-session-load-more"
                  type="button"
                  ?disabled=${state.sidebarSessionListLoading || controlsDisabled}
                  @click=${() =>
                    void loadSidebarSessionList(state, {
                      append: true,
                      offset: loadMoreOffset,
                    })}
                >
                  ${t("chat.selectors.loadMoreSessions")}
                </button>`
              : nothing}
          </div>`
        : nothing}
    </section>
  `;
}

function renderCollapsedSidebarSessionList(
  state: AppViewState,
  params: {
    newSessionDisabled: boolean;
    newSessionTitle: string;
    onNewSession: () => void | Promise<void>;
    onSwitchSession: SidebarSessionSwitchHandler;
  },
) {
  return html`
    <section class="sidebar-sessions sidebar-sessions--collapsed">
      <button
        type="button"
        class="sidebar-new-session"
        title=${params.newSessionTitle}
        aria-label=${t("chat.runControls.newSession")}
        ?disabled=${params.newSessionDisabled}
        @click=${() => {
          if (!params.newSessionDisabled) {
            void params.onNewSession();
          }
        }}
      >
        <span class="sidebar-new-session__icon" aria-hidden="true">${icons.plus}</span>
      </button>
      <div class="sidebar-session-select sidebar-session-select--collapsed">
        ${renderChatSessionSelect(state, params.onSwitchSession, {
          compact: true,
          sessionSwitcherOnly: true,
          surface: "sidebar",
        })}
      </div>
    </section>
  `;
}

export function renderSidebarSessionList(
  state: AppViewState,
  params: {
    collapsed: boolean;
    onNewSession: () => void | Promise<void>;
    onSwitchSession: SidebarSessionSwitchHandler;
  },
) {
  const busy = isSidebarSessionBusy(state);
  const newSessionDisabled = !state.connected || state.sessionsLoading || busy || !state.client;
  const newSessionTitle = !state.connected
    ? "Connect to create a new session"
    : busy
      ? "Finish the active run before creating a new session"
      : "New session";

  return params.collapsed
    ? renderCollapsedSidebarSessionList(state, {
        newSessionDisabled,
        newSessionTitle,
        onNewSession: params.onNewSession,
        onSwitchSession: params.onSwitchSession,
      })
    : renderExpandedSidebarSessionList(state, {
        newSessionDisabled,
        newSessionTitle,
        onNewSession: params.onNewSession,
        onSwitchSession: params.onSwitchSession,
      });
}
