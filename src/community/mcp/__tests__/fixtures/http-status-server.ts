// HTTP fixture that returns a fixed status code for every request.
// Status comes from HTTP_STATUS env (default 404). Prints {"port": <n>} to stdout.
const status = Number(process.env.HTTP_STATUS ?? "404");
const bunServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    return new Response("error", { status });
  },
});
console.info(JSON.stringify({ port: bunServer.port }));
process.on("SIGTERM", () => bunServer.stop());
