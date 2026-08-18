import { consumeRemoteRouteForToolCall } from "./backend-registry.ts";

/** Resolve file-tool operations after Permissions authorization without ever falling back locally from YOLO. */
export function authorizedRemoteOperations<T>(toolCallId: string, resolveRemote: () => T | undefined): T | undefined {
  const authorization = consumeRemoteRouteForToolCall(toolCallId);
  if (authorization.required && !authorization.route) {
    throw new Error("Remote Handoff route changed after YOLO authorization");
  }
  const operations = resolveRemote();
  if (authorization.required && !operations) {
    throw new Error("Remote Handoff route is unavailable for a YOLO-authorized tool call");
  }
  return operations;
}
