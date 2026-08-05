import net from "net";

const ports = [Number(process.env.PORT || 3123)];
const host = "127.0.0.1";

function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolve({ port, ok: false, detail: "already in use" });
        return;
      }
      resolve({ port, ok: false, detail: error.message });
    });

    server.once("listening", () => {
      server.close(() => resolve({ port, ok: true, detail: "available" }));
    });

    server.listen(port, host);
  });
}

const results = await Promise.all(ports.map(checkPort));
const blocked = results.filter((result) => !result.ok);

if (blocked.length > 0) {
  console.error("Required dev ports are not available:");
  blocked.forEach((result) => {
    console.error(`- ${result.port}: ${result.detail}`);
  });
  console.error("Stop the existing process before launching this project.");
  process.exit(1);
}

console.log(`Dev port available: ${ports[0]}`);
