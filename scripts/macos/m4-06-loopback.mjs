/**
 * Preload for the M4-06 macOS proof (node --import): the reference share
 * server (scripts/share-server.mjs, unchanged) listens on 0.0.0.0, every
 * interface of the Mac. The proof keeps it on loopback: a listen on 0.0.0.0,
 * :: or no host is moved to 127.0.0.1 before it binds.
 */
import net from "node:net";

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === "number" && (args[1] === undefined || typeof args[1] === "function" || ["0.0.0.0", "::", ""].includes(args[1]))) {
    const rest = typeof args[1] === "function" ? args.slice(1) : args.slice(2);
    return listen.call(this, args[0], "127.0.0.1", ...rest);
  }
  return listen.apply(this, args);
};
