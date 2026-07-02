export function normalizeToolName(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const aliases = { bash: "exec", "apply-patch": "apply_patch" };
  return aliases[normalized] ?? normalized;
}

export function couldNormalizeToolNamePrefixToAllowedTool(prefix, allowedToolNames) {
  const normalizedPrefix = normalizeToolName(prefix);
  if (!normalizedPrefix) {
    return false;
  }
  for (const toolName of allowedToolNames ?? []) {
    const normalizedToolName = normalizeToolName(toolName);
    const foldedToolName = String(toolName ?? "").trim().toLowerCase();
    if (!normalizedToolName && !foldedToolName) {
      continue;
    }
    if (
      normalizedToolName.startsWith(normalizedPrefix) ||
      foldedToolName.startsWith(normalizedPrefix)
    ) {
      return true;
    }
    const resolvedPrefix = normalizeToolName(normalizedPrefix);
    if (resolvedPrefix !== normalizedPrefix && normalizedToolName.startsWith(resolvedPrefix)) {
      return true;
    }
  }
  return false;
}

export function normalizeToolList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((value) => normalizeToolName(value))
    .filter((value) => value && value.length > 0);
}

export function expandToolGroups(list) {
  return normalizeToolList(list);
}

export function resolveToolProfilePolicy() {
  return undefined;
}

export const TOOL_GROUPS = {};
