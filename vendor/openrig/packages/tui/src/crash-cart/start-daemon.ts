/** Starting a local instance must never silently target the default daemon or
 * launch kernel occupants before the user has selected them. */
export function daemonStartArgs(target: string): string[] {
  const url = new URL(target);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("This target is not a local daemon endpoint. Reconnect after its owner starts it; no local daemon was started.");
  }
  return ["daemon", "start", "--no-kernel", "--host", url.hostname.replace(/^\[|\]$/g, ""),
    "--port", url.port || "80"];
}
