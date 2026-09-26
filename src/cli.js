/**
 * 管理命令。用法：
 *   node src/cli.js serve --dir ./data --port 8080
 *   node src/cli.js export-report --dir ./data --view organization
 *   node src/cli.js export-report --dir ./data --view brand --out brand.json
 *   node src/cli.js replay-info --dir ./data
 */
import { createApp } from "./app.js";
import { createServer } from "./http/server.js";

async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseFlags(rest);

  if (command === "serve") {
    const { service } = await createApp({ dir: args.dir ?? "./data" });
    const port = Number(args.port ?? 8080);
    const server = createServer(service);
    await new Promise((resolve) => server.listen(port, resolve));
    console.log(JSON.stringify({ listening: port, dataDir: args.dir ?? "./data" }));
    return "serve";
  }

  if (command === "export-report") {
    const { service, replayed } = await createApp({ dir: args.dir ?? "./data" });
    const view = args.view ?? "organization";
    let report;
    if (view === "brand") report = service.brandReport();
    else if (view === "organization") report = service.organizationReport();
    else throw new Error("--view 必须是 organization 或 brand");
    const text = JSON.stringify(report, null, 2);
    if (args.out) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args.out, text);
      console.log(JSON.stringify({ exported: true, view, replayed, path: args.out }));
    } else {
      process.stdout.write(text + "\n");
    }
    return "export-report";
  }

  if (command === "replay-info") {
    const { replayed } = await createApp({ dir: args.dir ?? "./data" });
    console.log(JSON.stringify({ replayed }));
    return "replay-info";
  }

  console.error("未知命令。可用: serve, export-report, replay-info");
  process.exitCode = 2;
  return "unknown";
}

function parseFlags(rest) {
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const v = rest[i];
    if (v.startsWith("--")) {
      const key = v.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

main(process.argv.slice(2)).catch((err) => {
  console.error(String(err));
  process.exit(1);
});
